const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function createZendeskTicket(comment, videoUrl) {
  try {
    const response = await axios.post(
      `https://d3v-nkstudio.zendesk.com/api/v2/tickets.json`,
      {
        ticket: {
          subject: `TikTok Lead: @${comment.authorMeta?.name || 'User'}`,
          comment: {
            body: `New Lead Found!\n\nUser: @${comment.authorMeta?.name}\nComment: "${comment.text}"\n\nVideo: ${videoUrl}`
          },
          external_id: `tiktok_${comment.id}`
        }
      },
      {
        auth: {
          username: `bidizola@gmail.com/token`,
          password: process.env.ZENDESK_API_TOKEN
        }
      }
    );
    return response.data.ticket.id;
  } catch (error) {
    console.error("Zendesk Error:", error.response?.data || error.message);
    return null;
  }
}

module.exports = async (req, res) => {
  try {
    const { data: videos, error: dbError } = await supabase
      .from('monitored_videos')
      .select('*')
      .eq('is_active', true);

    if (dbError) throw dbError;

    for (const video of videos) {
      const apifyUrl = `https://api.apify.com/v2/acts/apidojo~tiktok-comments-scraper/runs?token=${process.env.APIFY_TOKEN}`;
      const apifyRun = await axios.post(apifyUrl, {
        "startUrls": [{ "url": video.tiktok_url }],
        "maxCommentsPerVideo": 10
      });

      await new Promise(resolve => setTimeout(resolve, 8000)); // Increased wait for Apify

      const datasetId = apifyRun.data.data.defaultDatasetId;
      const results = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items`);

      for (const comment of results.data) {
        // SAFETY CHECK: Skip if comment has no text
        if (!comment.text) continue;

        const { data: existing } = await supabase
          .from('processed_comments')
          .select('id')
          .eq('tiktok_comment_id', comment.id)
          .single();

        if (existing) continue;

        // SAFETY CHECK: Ensure keywords exists and is an array
        const keywords = Array.isArray(video.keywords) ? video.keywords : [];
        
        const match = keywords.some(k => 
          k && comment.text.toLowerCase().includes(k.toLowerCase())
        );

        if (match) {
          const ticketId = await createZendeskTicket(comment, video.tiktok_url);
          if (ticketId) {
            await supabase.from('processed_comments').insert({
              tiktok_comment_id: comment.id,
              video_id: video.id,
              zendesk_ticket_id: ticketId,
              comment_text: comment.text
            });
          }
        }
      }
    }

    return res.status(200).json({ success: true, message: "Scan complete" });

  } catch (error) {
    console.error("FULL ERROR DETAIL:", error.response?.data || error.message);
    return res.status(500).json({ 
        error: "Internal failure", 
        detail: error.response?.data || error.message 
    });
  }
};