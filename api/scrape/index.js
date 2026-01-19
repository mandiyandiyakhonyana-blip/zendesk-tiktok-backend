import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Prevent Vercel from caching the response
  res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
  
  const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 1. Fetch URLs to track from your database
    const { data: videos, error: vError } = await supabase.from('videos').select('*');
    if (vError) throw vError;
    
    if (!videos || videos.length === 0) {
      return res.status(200).json({ success: true, message: "No videos in database." });
    }

    console.log(`Found ${videos.length} videos. Triggering Apify runs...`);

    for (const video of videos) {
      // 2. Trigger the Apify Actor
      // Using 'postURLs' and 'commentsPerPost' to satisfy the Clockworks Actor requirements
      const apifyResponse = await fetch(`https://api.apify.com/v2/acts/clockworks~tiktok-comments-scraper/runs?token=${process.env.APIFY_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          "postURLs": [video.url],
          "commentsPerPost": 30,
          "proxyConfiguration": { 
            "useApifyProxy": true, 
            "groups": ["BUYPROXIES94952"] 
          },
          "webhooks": [
            {
              "eventTypes": ["ACTOR.RUN.SUCCEEDED"],
              "requestUrl": `https://zendesk-tiktok-backend.vercel.app/api/webhook`,
              "payloadTemplate": `{
                "resource": {{resource}},
                "videoUrl": "${video.url}"
              }`
            }
          ]
        })
      });

      const runInfo = await apifyResponse.json();
      console.log(`Run triggered for ${video.url}:`, runInfo.data?.id);
    }

    // 3. Respond instantly to stay within Vercel's 10s execution limit
    return res.status(200).json({ 
      success: true, 
      message: "Scraper runs triggered successfully. Apify is processing. Check Zendesk in ~1-2 minutes." 
    });

  } catch (error) {
    console.error("Trigger Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
