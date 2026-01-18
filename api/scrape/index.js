const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Initialize Supabase Client
// Note: We use process.env to keep your credentials secure in Vercel
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper: Match TikTok comments against your Supabase keywords
function matchesKeywords(text, keywords) {
  const lowerText = text.toLowerCase();
  return keywords.filter(keyword => {
    const cleanKeyword = keyword.toLowerCase().trim();
    return lowerText.includes(cleanKeyword);
  });
}

// Helper: Create the actual Zendesk Ticket
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
          external_id: `tiktok_${comment.id}`, // Prevents duplicate tickets in Zendesk
          custom_fields: [
            { id: 42086607230993, value: videoUrl } // Your TikTok URL field ID
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

// MAIN EXPORT: This is what Vercel calls
export default async function handler(req, res) {
  // Ensure it's a POST request (standard for webhooks/scrapers)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Please use POST' });
  }

  try {
    console.log('--- Starting TikTok Scan ---');

    // 1. Get active videos from Supabase
    const { data: videos, error: dbError } = await supabase
      .from('monitored_videos')
      .select('*')
      .eq('is_active', true);

    if (dbError) throw dbError;
    if (!videos || videos.length === 0) {
      return res.status(200).json({ message: 'No active videos to scan.' });
    }

    let totalTicketsCreated = 0;

    // 2. Loop through each video in your database
    for (const video of videos) {
      console.log(`Scanning video: ${video.tiktok_url}`);

      // 3. Trigger Apify Scraper for this specific video
      const apifyRun = await axios.post(
        `https://api.apify.com/v2/acts/apidojo~tiktok-comments-scraper/runs?token=${process.env.APIFY_TOKEN}`,
        {
          videoUrls: [video.tiktok_url],
          maxCommentsPerVideo: 20
        }
      );

      // Wait 5 seconds for Apify to start processing
      await new Promise(resolve => setTimeout(resolve, 5000));

      const datasetId = apifyRun.data.data.defaultDatasetId;
      const results = await axios.get(
        `https://api.apify.com/v2/datasets/${datasetId}/items`
      );

      // 4. Process each comment found
      for (const comment of results.data) {
        // Check Supabase to see if we already handled this comment
        const { data: existing } = await supabase
          .from('processed_comments')
          .select('id')
          .eq('tiktok_comment_id', comment.id)
          .single();

        if (existing) continue; // Skip if already ticketed

        // 5. Check if comment has "Buy/Refund/Broken" keywords
        const matches = matchesKeywords(comment.text, video.keywords || []);

        if (matches.length > 0) {
          console.log(`Match found! Creating ticket for: ${comment.text}`);

          // 6. Send to Zendesk
          const ticketId = await createZendeskTicket(comment, video.tiktok_url, matches);

          if (ticketId) {
            // 7. Save to 'processed_comments' so we don't do it again
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
    console.error('CRITICAL ERROR:', error.message);
    return res.status(500).json({ error: error.message });
  }
}