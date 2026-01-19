import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { resource, videoUrl } = req.body;
    const datasetId = resource?.defaultDatasetId;
    if (!datasetId) return res.status(400).send("Missing Dataset ID");

    // 1. Fetch the scraped comments
    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${process.env.APIFY_API_TOKEN}`);
    const items = await itemsRes.json();

    // 2. Fetch keywords for this specific video
    const { data: videoData } = await supabase.from('videos').select('keywords').eq('url', videoUrl).single();
    const keywords = videoData?.keywords?.map(k => k.toLowerCase().trim()) || [];

    console.log(`WEBHOOK: Received ${items.length} comments for ${videoUrl}. Keywords: [${keywords}]`);

    const leadsAdded = [];

    for (const item of items) {
      const commentText = (item.text || "").toLowerCase();
      const username = item.authorMeta?.uniqueId || "User";
      const commentId = item.id || item.cid;

      // Check for keyword match
      const isMatch = keywords.some(kw => commentText.includes(kw));

      if (isMatch) {
        // Prevent duplicate tickets
        const { data: exists } = await supabase.from('leads').select('id').eq('external_id', commentId).single();
        if (exists) continue;

        // 3. Create Zendesk Ticket
        const auth = Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64');
        const zRes = await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ticket: {
              subject: `TikTok Lead: @${username}`,
              comment: { body: `Lead Found!\n\nUser: @${username}\nComment: ${item.text}\nLink: ${videoUrl}` },
              priority: "urgent"
            }
          })
        });

        if (zRes.ok) {
          await supabase.from('leads').insert([{
            video_url: videoUrl,
            username,
            comment_text: item.text,
            external_id: commentId
          }]);
          leadsAdded.push(username);
        }
      }
    }

    console.log(`✅ Done. Leads Created: ${leadsAdded.length}`);
    return res.status(200).json({ success: true, count: leadsAdded.length });

  } catch (error) {
    console.error("WEBHOOK ERROR:", error.message);
    return res.status(500).send(error.message);
  }
}
