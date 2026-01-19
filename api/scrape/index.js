import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Prevent caching
  res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
  
  const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 1. Fetch URLs to track
    const { data: videos, error: vError } = await supabase.from('videos').select('*');
    if (vError) throw vError;
    if (!videos || videos.length === 0) {
      return res.status(200).json({ success: true, message: "No videos in database." });
    }

    console.log(`Triggering scrape for ${videos.length} videos...`);

    for (const video of videos) {
      // 2. Fire and Forget to Apify
      // We add a 'webhook' to the payload so Apify calls us back when done
      await fetch(`https://api.apify.com/v2/acts/clockworks~tiktok-comments-scraper/runs?token=${process.env.APIFY_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrls: [video.url],
          resultsPerPage: 30,
          proxyConfiguration: { 
            useApifyProxy: true, 
            groups: ["BUYPROXIES94952"] 
          },
          // This is the "Magic" part - Apify will ping your webhook endpoint
          webhooks: [
            {
              eventTypes: ["ACTOR.RUN.SUCCEEDED"],
              requestUrl: `https://zendesk-tiktok-backend.vercel.app/api/webhook`,
              payloadTemplate: `{
                "resource": {{resource}},
                "videoUrl": "${video.url}"
              }`
            }
          ]
        })
      });
      console.log(`Run triggered for: ${video.url}`);
    }

    // 3. Respond immediately to stay under 10s limit
    return res.status(200).json({ 
      success: true, 
      message: "Scraper runs triggered. Apify is processing. Leads will hit Zendesk in 1-2 minutes." 
    });

  } catch (error) {
    console.error("Trigger Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
