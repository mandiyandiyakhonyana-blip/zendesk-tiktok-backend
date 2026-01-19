import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // 1. Verify this is a POST request from Apify
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // Apify sends the run details in the body
    // We specifically need the defaultDatasetId to fetch the comments
    const { resource, videoUrl } = req.body;
    const datasetId = resource?.defaultDatasetId;

    if (!datasetId) {
      console.error("No dataset ID found in webhook payload");
      return res.status(400).send("Missing datasetId");
    }

    console.log(`Processing dataset: ${datasetId} for video: ${videoUrl}`);

    // 2. Fetch the actual scraped items from Apify
    const apifyItemsResponse = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${process.env.APIFY_API_TOKEN}`
    );
    const items = await apifyItemsResponse.json();

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(200).send("No items to process.");
    }

    // 3. Get keywords for this specific video from Supabase
    const { data: videoData, error: vError } = await supabase
      .from('videos')
      .select('keywords')
      .eq('url', videoUrl)
      .single();

    if (vError || !videoData) {
      console.error("Could not find video/keywords in DB for:", videoUrl);
      return res.status(200).send("Video not tracked.");
    }

    const keywords = videoData.keywords || [];
    const processedUsers = [];

    // 4. Match comments against keywords
    for (const item of items) {
      const rawText = item.text || item.commentText || "";
      const text = rawText.toLowerCase();
      const username = item.authorMeta?.uniqueId || item.uniqueId || "TikTok_User";
      const commentId = item.id || item.cid;

      const hasMatch = keywords.some(kw => text.includes(kw.toLowerCase()));

      if (hasMatch) {
        // Check if lead already exists to prevent duplicate Zendesk tickets
        const { data: exists } = await supabase
          .from('leads')
          .select('id')
          .eq('external_id', commentId)
          .single();

        if (exists) continue;

        // 5. Create Zendesk Ticket
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
                body: `New Lead Found!\n\nUser: @${username}\nComment: "${rawText}"\nVideo: ${videoUrl}` 
              },
              priority: "urgent"
            }
          })
        });

        if (zRes.ok) {
          // 6. Log the successful lead in Supabase
          await supabase.from('leads').insert([{
            video_url: videoUrl,
            username: username,
            comment_text: rawText,
            external_id: commentId
          }]);
          processedUsers.push(username);
        }
      }
    }

    console.log(`Successfully processed ${processedUsers.length} leads.`);
    return res.status(200).json({ success: true, leadsAdded: processedUsers.length });

  } catch (error) {
    console.error("Webhook System Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
