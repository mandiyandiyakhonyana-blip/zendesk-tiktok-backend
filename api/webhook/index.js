import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  // Apify sends the datasetId in the body
  const { resource } = req.body;
  const datasetId = resource?.defaultDatasetId;

  if (!datasetId) return res.status(400).send('No dataset found');

  // 1. Get the items from Apify
  const response = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${process.env.APIFY_API_TOKEN}`);
  const items = await response.json();

  // 2. Get your videos/keywords from Supabase
  const { data: videos } = await supabase.from('videos').select('*');

  for (const video of videos) {
    // Only process items belonging to this video URL
    const videoItems = items.filter(i => i.videoUrl === video.url || i.url === video.url);
    
    for (const item of videoItems) {
      const text = (item.text || "").toLowerCase();
      const match = video.keywords.some(kw => text.includes(kw.toLowerCase()));

      if (match) {
        const { data: exists } = await supabase.from('leads').select('id').eq('external_id', item.id).single();
        if (exists) continue;

        // 3. Send to Zendesk
        const auth = Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64');
        await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ticket: {
              subject: `TikTok Lead: @${item.authorMeta?.uniqueId}`,
              comment: { body: `Lead Found!\n\nUser: @${item.authorMeta?.uniqueId}\nComment: ${item.text}\nVideo: ${video.url}` },
              priority: "urgent"
            }
          })
        });

        // 4. Save Lead
        await supabase.from('leads').insert([{ 
            video_url: video.url, 
            username: item.authorMeta?.uniqueId, 
            comment_text: item.text, 
            external_id: item.id 
        }]);
      }
    }
  }
  return res.status(200).send('Webhook processed');
}
