import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // 1. Only allow POST requests from Apify
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 2. Parse the payload from Apify
    // We expect { "resource": { "defaultDatasetId": "..." }, "videoUrl": "..." }
    const { resource, videoUrl } = req.body;
    const datasetId = resource?.defaultDatasetId;

    if (!datasetId) {
      console.error("❌ WEBHOOK ERROR: No datasetId found in payload.");
      return res.status(400).send("Missing datasetId");
    }

    console.log(`--- Processing Webhook for Video: ${videoUrl} ---`);

    // 3. Fetch the scraped comments from Apify's dataset
    const apifyUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${process.env.APIFY_API_TOKEN}`;
    const apifyResponse = await fetch(apifyUrl);
    const items = await apifyResponse.json();

    if (!Array.isArray(items) || items.length === 0) {
      console.log("⚠️ WEBHOOK: Dataset is empty. No comments to process.");
      return res.status(200).send("No items.");
    }

    // 4. Fetch keywords for this specific video from Supabase
    const { data: videoData, error: vError } = await supabase
      .from('videos')
      .select('keywords')
      .eq('url', videoUrl)
      .single();

    if (vError || !videoData) {
      console.error(`❌ WEBHOOK: Video URL ${videoUrl} not found in database.`);
      return res.status(200).send("Video not tracked.");
    }

    // Clean keywords (trim and lowercase)
    const keywords = (videoData.keywords || []).map(kw => kw.toLowerCase().trim());
    console.log(`🔍 Checking ${items.length} comments against keywords: [${keywords.join(', ')}]`);

    let matchCount = 0;

    // 5. Loop through comments and match
    for (const item of items) {
      const rawText = item.text || item.commentText || "";
      const text = rawText.toLowerCase();
      const username = item.authorMeta?.uniqueId || item.uniqueId || "TikTok_User";
      const commentId = item.id || item.cid || `manual_${Date.now()}`;

      // Check if any keyword is present in the comment
      const hasMatch = keywords.some(kw => text.includes(kw));

      if (hasMatch) {
        // Double-check: Prevent duplicate lead entry for the same comment
        const { data: existingLead } = await supabase
          .from('leads')
          .select('id')
          .eq('external_id', commentId)
          .single();

        if (existingLead) continue;

        console.log(`🎯 MATCH FOUND: "@${username}: ${rawText}"`);

        // 6. Create Zendesk Ticket
        const zSub = process.env.ZENDESK_SUBDOMAIN;
        const zEmail = process.env.ZENDESK_EMAIL;
        const zToken = process.env.ZENDESK_API_TOKEN;
        const auth = Buffer.from(`${zEmail}/token:${zToken}`).toString('base64');

        const zendeskResponse = await fetch(`https://${zSub}.zendesk.com/api/v2/tickets.json`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            ticket: {
              subject: `TikTok Lead: @${username}`,
              comment: { 
                body: `New Lead Found on TikTok!\n\nUser: @${username}\nComment: "${rawText}"\nVideo Link: ${videoUrl}` 
              },
              priority: "urgent"
            }
          })
        });

        if (zendeskResponse.ok) {
          // 7. Save to Leads Table
          await supabase.from('leads').insert([{
            video_url: videoUrl,
            username: username,
            comment_text: rawText,
            external_id: commentId
          }]);
          matchCount++;
        } else {
          const zErr = await zendeskResponse.text();
          console.error(`❌ ZENDESK API ERROR: ${zErr}`);
        }
      }
    }

    console.log(`✅ Webhook Complete. Found ${matchCount} new leads.`);
    return res.status(200).json({ success: true, newLeads: matchCount });

  } catch (error) {
    console.error("❌ WEBHOOK CRITICAL SYSTEM ERROR:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
