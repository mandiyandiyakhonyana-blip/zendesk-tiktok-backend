import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Prevent Vercel from caching the response
  res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
  
  const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 1. Get targets from Supabase
    const { data: videos, error: vError } = await supabase.from('videos').select('*');
    if (vError) throw vError;
    if (!videos || videos.length === 0) {
      return res.status(200).json({ success: true, message: "No videos in database." });
    }

    const allLeads = [];

    for (const video of videos) {
      console.log(`Processing: ${video.url}`);

      // 2. Call Apify with Proxy bypass (using your specific proxy group)
      const apifyResponse = await fetch(`https://api.apify.com/v2/acts/clockworks~tiktok-comments-scraper/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrls: [video.url],
          resultsPerPage: 20,
          proxyConfiguration: {
            useApifyProxy: true,
            groups: ["BUYPROXIES94952"] 
          }
        })
      });

      const comments = await apifyResponse.json();

      if (!Array.isArray(comments)) {
        console.error("Apify Error:", comments);
        continue; // Skip this video if the scraper failed
      }

      // 3. Match and Send to Zendesk
      for (const c of comments) {
        // Handle various field names from different scraper versions
        const rawText = c.text || c.commentText || "";
        const username = c.authorMeta?.uniqueId || c.uniqueId || "TikTok_User";
        const commentId = c.id || c.cid;

        const text = rawText.toLowerCase();
        const match = video.keywords.some(kw => text.includes(kw.toLowerCase()));

        if (match) {
          // Check if we already sent this one
          const { data: exists } = await supabase
            .from('leads')
            .select('id')
            .eq('external_id', commentId)
            .single();

          if (exists) continue;

          // Zendesk Integration
          const zSub = process.env.ZENDESK_SUBDOMAIN;
          const zEmail = process.env.ZENDESK_EMAIL;
          const zToken = process.env.ZENDESK_API_TOKEN;
          const auth = Buffer.from(`${zEmail}/token:${zToken}`).toString('base64');

          const zRes = await fetch(`https://${zSub}.zendesk.com/api/v2/tickets.json`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              ticket: {
                subject: `TikTok Lead: @${username}`,
                comment: { 
                  body: `New Lead Found!\n\nUser: @${username}\nComment: "${rawText}"\nVideo: ${video.url}` 
                },
                priority: "urgent"
              }
            })
          });

          if (zRes.ok) {
            // Save to Supabase to prevent duplicates
            await supabase.from('leads').insert([{
              video_url: video.url,
              username: username,
              comment_text: rawText,
              external_id: commentId
            }]);
            allLeads.push(username);
          }
        }
      }
    }

    return res.status(200).json({ 
      success: true, 
      leadsProcessed: allLeads.length,
      users: allLeads 
    });

  } catch (error) {
    console.error("System Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
