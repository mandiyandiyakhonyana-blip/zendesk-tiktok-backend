const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper to create Zendesk Ticket
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
          external_id: `tiktok_${comment.id}` // Prevents duplicates
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
  console.log("--- WORKER STARTED ---");
  
  try {
    // 1. Fetch active videos from Supabase
    const { data: videos, error: dbError } = await supabase
      .from('monitored_videos')
      .select('*')
      .eq('is_active', true);

    if (dbError) throw dbError;
    console.log(`Checking ${videos?.length || 0} videos...`);

    for (const video of videos) {
      // 2. Call Apify Scraper
      const apifyUrl = `https://api.apify.com/v2/acts/apidojo~tiktok-comments-scraper/runs?token=${process.env.APIFY_TOKEN}`;
      const apifyRun = await axios.post(apifyUrl, {
        videoUrls: [video.tiktok_url],
        maxCommentsPerVideo: 10
      });

      // Wait 5 seconds for data to prepare
      await new Promise(resolve => setTimeout(resolve, 5000));

      const datasetId = apifyRun.data.data.defaultDatasetId;
      const results = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items`);

      for (const comment of results.data) {
        // 3. Check if we already processed this specific comment
        const { data: existing } = await supabase
          .from('processed_comments')
          .select('id')
          .eq('tiktok_comment_id', comment.id)
          .single();

        if (existing) continue;

        // 4. Simple keyword match (case-insensitive)
        const keywords = video.keywords || [];
        const match = keywords.some(k => comment.text.toLowerCase().includes(k.toLowerCase()));

        if (match) {
          console.log(`Found lead: ${comment.text}`);
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
    return res.status(error.response?.status || 500).json({ 
        error: "API rejected request", 
        detail: error.response?.data || error.message 
    });
  }
};