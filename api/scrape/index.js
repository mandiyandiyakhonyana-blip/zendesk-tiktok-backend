const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function matchesKeywords(text, keywords) {
  const lowerText = text.toLowerCase();
  return keywords.filter(keyword => {
    const cleanKeyword = keyword.toLowerCase().trim();
    return lowerText.includes(cleanKeyword);
  });
}

async function createZendeskTicket(comment, videoUrl, matchedKeywords) {
  try {
    const response = await axios.post(
      `https://d3v-nkstudio.zendesk.com/api/v2/tickets.json`,
      {
        ticket: {
          subject: `TikTok Lead: @${comment.authorMeta?.name || 'User'}`,
          comment: {
            body: `New TikTok Comment Found!\n\nUser: @${comment.authorMeta?.name}\nComment: "${comment.text}"\n\n---\nMatched Keywords: ${matchedKeywords.join(', ')}\nVideo Link: ${videoUrl}`
          },
          external_id: `tiktok_${comment.id}`, 
          custom_fields: [
            { id: 42086607230993, value: videoUrl } 
          ]
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
    console.error('Zendesk API Error:', error.response?.data || error.message);
    return null;
  }
}

// Vercel Serverless Entry Point
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Please use POST' });
  }

  try {
    const { data: videos, error: dbError } = await supabase
      .from('monitored_videos')
      .select('*')
      .eq('is_active', true);

    if (dbError) throw dbError;
    if (!videos || videos.length === 0) {
      return res.status(200).json({ message: 'No active videos to scan.' });
    }

    let totalTicketsCreated = 0;

    for (const video of videos) {
      const apifyRun = await axios.post(
        `https://api.apify.com/v2/acts/apidojo~tiktok-comments-scraper/runs?token=${process.env.APIFY_TOKEN}`,
        {
          videoUrls: [video.tiktok_url],
          maxCommentsPerVideo: 20
        }
      );

      await new Promise(resolve => setTimeout(resolve, 5000));

      const datasetId = apifyRun.data.data.defaultDatasetId;
      const results = await axios.get(
        `https://api.apify.com/v2/datasets/${datasetId}/items`
      );

      for (const comment of results.data) {
        const { data: existing } = await supabase
          .from('processed_comments')
          .select('id')
          .eq('tiktok_comment_id', comment.id)
          .single();

        if (existing) continue;

        const matches = matchesKeywords(comment.text, video.keywords || []);

        if (matches.length > 0) {
          const ticketId = await createZendeskTicket(comment, video.tiktok_url, matches);

          if (ticketId) {
            await supabase.from('processed_comments').insert({
              tiktok_comment_id: comment.id,
              video_id: video.id,
              zendesk_ticket_id: ticketId,
              comment_text: comment.text,
              matched_keywords: matches
            });
            totalTicketsCreated++;
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      tickets_created: totalTicketsCreated,
      message: `Scan complete.`
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
