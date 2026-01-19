import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: videos } = await supabase.from('videos').select('*');
    if (!videos || videos.length === 0) return res.json({ success: true, message: "No videos to track" });

    const allLeads = [];

    for (const video of videos) {
      console.log(`Scraping: ${video.url}`);
      
      // UPDATED ACTOR: Using clockworks/tiktok-comments-scraper (more stable)
      const apifyResponse = await fetch(`https://api.apify.com/v2/acts/clockworks~tiktok-comments-scraper/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          "resultsPerPage": 20,
          "videoUrls": [video.url]
        })
      });

      const comments = await apifyResponse.json();

      if (!Array.isArray(comments)) {
        console.error("Apify Error Response:", comments);
        continue;
      }

      for (const c of comments) {
        const rawText = c.text || "";
        const username = c.authorMeta?.uniqueId || "User";
        const commentId = c.id;

        const text = rawText.toLowerCase();
        const match = video.keywords.some(kw => text.includes(kw.toLowerCase()));

        if (match) {
          const { data: exists } = await supabase.from('leads').select('id').eq('external_id', commentId).single();
          if (exists) continue;

          // Zendesk API
          const auth = Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64');
          const zRes = await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ticket: {
                subject: `TikTok Lead: @${username}`,
                comment: { body: `Lead Found!\n\nUser: @${username}\nComment: ${rawText}\nVideo: ${video.url}` },
                priority: "urgent"
              }
            })
          });

          if (zRes.ok) {
            await supabase.from('leads').insert([{ video_url: video.url, username, comment_text: rawText, external_id: commentId }]);
            allLeads.push(username);
          }
        }
      }
    }
    return res.status(200).json({ success: true, leadsProcessed: allLeads.length });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
