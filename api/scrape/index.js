import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: videos } = await supabase.from('videos').select('*');
    if (!videos || videos.length === 0) return res.json({ success: true, message: "No videos found" });

    const allLeads = [];

    for (const video of videos) {
      console.log(`🚀 Starting Scraper for: ${video.url}`);

      // START THE RUN (Using the specific Clockworks Actor)
      const startRun = await fetch(`https://api.apify.com/v2/acts/clockworks~tiktok-comments-scraper/runs?token=${process.env.APIFY_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrls: [video.url],
          resultsPerPage: 30, // Increased to get more leads
          proxyConfiguration: { useApifyProxy: true, groups: ["BUYPROXIES94952"] }
        })
      });

      const runData = await startRun.json();
      const runId = runData.data?.id;

      if (!runId) {
        console.error("Failed to start Apify run:", runData);
        continue;
      }

      console.log(`🏃 Run started: ${runId}. Waiting for results...`);

      // WAIT FOR RESULTS (Polling for max 8 seconds to stay under Vercel's 10s limit)
      let results = [];
      const startTime = Date.now();
      
      while (Date.now() - startTime < 8000) {
        const checkRun = await fetch(`https://api.apify.com/v2/acts/clockworks~tiktok-comments-scraper/runs/${runId}?token=${process.env.APIFY_API_TOKEN}`);
        const status = await checkRun.json();
        
        if (status.data.status === 'SUCCEEDED') {
          const getItems = await fetch(`https://api.apify.com/v2/runs/${runId}/dataset/items?token=${process.env.APIFY_API_TOKEN}`);
          results = await getItems.json();
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1500)); // Wait 1.5s between checks
      }

      if (results.length === 0) {
        console.log(`⏳ Run ${runId} is still processing or returned no items.`);
        continue;
      }

      console.log(`✅ Found ${results.length} comments. Filtering...`);

      // MATCHING LOGIC
      for (const c of results) {
        const rawText = c.text || c.commentText || "";
        const username = c.authorMeta?.uniqueId || "User";
        const commentId = c.id || c.cid;

        const text = rawText.toLowerCase();
        const isMatch = video.keywords.some(kw => text.includes(kw.toLowerCase()));

        if (isMatch) {
          const { data: exists } = await supabase.from('leads').select('id').eq('external_id', commentId).single();
          if (exists) continue;

          // ZENDESK POST
          const auth = Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64');
          await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
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

          await supabase.from('leads').insert([{ video_url: video.url, username, comment_text: rawText, external_id: commentId }]);
          allLeads.push(username);
        }
      }
    }

    return res.status(200).json({ success: true, leadsFound: allLeads.length, leads: allLeads });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
