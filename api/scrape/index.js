import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  console.log('--- STARTING SCRAPE RUN ---');

  try {
    const { data: videos, error: vError } = await supabase.from('videos').select('*');
    if (vError) throw vError;

    console.log(`Found ${videos.length} videos to track in Supabase.`);

    const allLeads = [];

    for (const video of videos) {
      console.log(`Scraping video: ${video.url}`);
      
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

      if (!Array.isArray(comments)) {
        console.error('Apify did not return an array. Check API Token. Response:', comments);
        continue;
      }

      console.log(`Apify found ${comments.length} total comments for this video.`);

      for (const comment of comments) {
        const commentText = comment.text || "";
        const text = commentText.toLowerCase();
        
        // Match keywords (case insensitive)
        const matchedKeywords = video.keywords.filter(kw => text.includes(kw.toLowerCase()));

        if (matchedKeywords.length > 0) {
          console.log(`MATCH FOUND! Keyword: [${matchedKeywords.join(', ')}] Text: "${commentText}"`);

          const { data: existingLead } = await supabase
            .from('leads')
            .select('id')
            .eq('external_id', comment.id)
            .single();

          if (existingLead) {
            console.log(`Lead ${comment.id} already exists in Supabase. Skipping.`);
            continue;
          }

          console.log(`Sending lead to Zendesk for user: ${comment.authorMeta?.uniqueId}`);

          const zendeskSub = process.env.ZENDESK_SUBDOMAIN;
          const zendeskEmail = process.env.ZENDESK_EMAIL;
          const zendeskToken = process.env.ZENDESK_API_TOKEN;
          const authString = Buffer.from(`${zendeskEmail}/token:${zendeskToken}`).toString('base64');

          const zResponse = await fetch(`https://${zendeskSub}.zendesk.com/api/v2/tickets.json`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${authString}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              ticket: {
                subject: `TikTok Lead: ${comment.authorMeta?.uniqueId || 'Unknown'}`,
                comment: {
                  body: `Lead found!\n\nUser: @${comment.authorMeta?.uniqueId}\nComment: "${commentText}"\nVideo: ${video.url}`
                },
                priority: "urgent"
              }
            })
          });

          if (zResponse.ok) {
            const zData = await zResponse.json();
            console.log(`✅ Zendesk Ticket Created: ${zData.ticket.id}`);

            await supabase.from('leads').insert([{
              video_url: video.url,
              username: comment.authorMeta?.uniqueId,
              comment_text: commentText,
              external_id: comment.id
            }]);
            
            allLeads.push({ user: comment.authorMeta?.uniqueId, ticketId: zData.ticket.id });
          } else {
            const errorBody = await zResponse.text();
            console.error(`❌ Zendesk API Error: ${zResponse.status} - ${errorBody}`);
          }
        }
      }
    }

    console.log('--- RUN FINISHED ---');
    return res.status(200).json({ success: true, leadsProcessed: allLeads.length });

  } catch (error) {
    console.error('SYSTEM CRASH:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
