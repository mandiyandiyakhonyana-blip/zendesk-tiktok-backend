import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // 1. FORCE NO CACHE (Fixes the 304 error)
  res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 2. GET TRACKED VIDEOS
    const { data: videos, error: vError } = await supabase.from('videos').select('*');
    if (vError) throw vError;

    const allLeads = [];

    for (const video of videos) {
      // 3. RUN APIFY TIKTOK SCRAPER
      // Using the TikTok Comment Scraper (apify/tiktok-comments-scraper)
      const apifyResponse = await fetch(`https://api.apify.com/v2/acts/apify~tiktok-comments-scraper/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postURLs: [video.url],
          commentsPerPost: 20,
          maxRepliesPerComment: 0
        })
      });

      const comments = await apifyResponse.json();

      if (!Array.isArray(comments)) continue;

      for (const comment of comments) {
        const text = comment.text.toLowerCase();
        const hasKeyword = video.keywords.some(kw => text.includes(kw.toLowerCase()));

        if (hasKeyword) {
          // 4. CHECK FOR DUPLICATES IN SUPABASE (Don't create the same ticket twice)
          const { data: existingLead } = await supabase
            .from('leads')
            .select('id')
            .eq('external_id', comment.id)
            .single();

          if (!existingLead) {
            // 5. CREATE ZENDESK TICKET
            const zendeskSub = process.env.ZENDESK_SUBDOMAIN; // Should be 'd3v-nkstudio'
            const zendeskEmail = process.env.ZENDESK_EMAIL;
            const zendeskToken = process.env.ZENDESK_API_TOKEN;

            const authString = Buffer.from(`${zendeskEmail}/token:${zendeskToken}`).toString('base64');

            const ticketBody = {
              ticket: {
                subject: `TikTok Lead: ${comment.authorMeta.uniqueId}`,
                comment: {
                  body: `New lead found on TikTok!\n\nUser: ${comment.authorMeta.nickname} (@${comment.authorMeta.uniqueId})\nComment: "${comment.text}"\nVideo URL: ${video.url}\n\nThis lead was captured because it matched your keywords: ${video.keywords.join(', ')}`
                },
                priority: "urgent",
                tags: ["tiktok_lead", "automated_capture"]
              }
            };

            const zResponse = await fetch(`https://${zendeskSub}.zendesk.com/api/v2/tickets.json`, {
              method: 'POST',
              headers: {
                'Authorization': `Basic ${authString}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(ticketBody)
            });

            if (zResponse.ok) {
              // 6. SAVE TO SUPABASE LEADS TABLE
              await supabase.from('leads').insert([{
                video_url: video.url,
                username: comment.authorMeta.uniqueId,
                comment_text: comment.text,
                external_id: comment.id // TikTok's unique comment ID
              }]);
              
              allLeads.push({ user: comment.authorMeta.uniqueId, status: 'Ticket Created' });
            }
          }
        }
      }
    }

    return res.status(200).json({ success: true, leadsFound: allLeads.length, details: allLeads });

  } catch (error) {
    console.error('Scrape Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
