// api/scrape/index.js - The main worker function
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// ===== CONFIGURATION =====
// You'll replace these with your actual values
const SUPABASE_URL = 'https://mdryyfcqlsutivwwpwrm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kcnl5ZmNxbHN1dGl2d3dwd3JtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2ODcxNDQ4NCwiZXhwIjoyMDg0MjkwNDg0fQ.Eey_Jb48uLydHNrXts081h1bTFUFHq1F4kn4qZHsJiM';
const ZENDESK_SUBDOMAIN = 'd3v-nkstudio';
const ZENDESK_EMAIL = 'bidizola@gmail.com';
const ZENDESK_API_TOKEN = 'Q2oKr58kr0NrUyN9Ly3nmPikBheNIvEMl1sCxdVS'; // Get a NEW one!
const APIFY_TOKEN = 'apify_api_PCoovThYJsbQubRwFgoMB2MojJwg9B22LTSG'; // From apify.com

// ===== INITIALIZE CLIENTS =====
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Simple keyword matching function
function matchesKeywords(text, keywords) {
  const lowerText = text.toLowerCase();
  return keywords.filter(keyword => {
    const cleanKeyword = keyword.toLowerCase().replace('?', '');
    const hasKeyword = lowerText.includes(cleanKeyword);
    const isQuestion = keyword.endsWith('?');
    
    if (isQuestion) {
      return hasKeyword && text.includes('?');
    }
    return hasKeyword;
  });
}

// Create Zendesk ticket (same as your working curl command)
async function createZendeskTicket(comment, videoUrl, matchedKeywords) {
  try {
    const response = await axios.post(
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`,
      {
        ticket: {
          subject: `TikTok: ${comment.text.substring(0, 50)}...`,
          comment: {
            body: `TikTok comment from @${comment.authorUsername}:\n\n"${comment.text}"\n\n---\nMatched keywords: ${matchedKeywords.join(', ')}\nVideo: ${videoUrl}`
          },
          external_id: `tiktok_${comment.id}`,
          tags: ['tiktok_campaign', 'filtered_lead'],
          type: 'incident',
          custom_fields: [
            { id: 42086607230993, value: videoUrl } // TikTok URL field
          ]
        }
      },
      {
        auth: {
          username: `${ZENDESK_EMAIL}/token`,
          password: ZENDESK_API_TOKEN
        }
      }
    );
    return response.data.ticket.id;
  } catch (error) {
    console.error('Failed to create Zendesk ticket:', error.response?.data || error.message);
    return null;
  }
}

// Main function - Vercel will call this
module.exports = async (req, res) => {
  try {
    console.log('Starting TikTok filter scan...');
    
    // 1. Get all active videos from database
    const { data: videos, error } = await supabase
      .from('monitored_videos')
      .select('*')
      .eq('is_active', true);
    
    if (error) throw error;
    if (!videos.length) {
      return res.json({ message: 'No videos to monitor' });
    }
    
    let processedCount = 0;
    
    // 2. Check each video
    for (const video of videos) {
      console.log(`Checking: ${video.tiktok_url}`);
      
      // 3. Call Apify to get new comments
      const apifyResponse = await axios.post(
        `https://api.apify.com/v2/acts/apidojo~tiktok-comments-scraper/runs?token=${APIFY_TOKEN}`,
        {
          videoUrls: [video.tiktok_url],
          maxCommentsPerVideo: 50
        }
      );
      
      // Wait a bit for scraping to complete
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // 4. Get the results
      const datasetId = apifyResponse.data.data.defaultDatasetId;
      const results = await axios.get(
        `https://api.apify.com/v2/datasets/${datasetId}/items`
      );
      
      // 5. Process each comment
      for (const comment of results.data) {
        // Check if we already processed this comment
        const { data: existing } = await supabase
          .from('processed_comments')
          .select('id')
          .eq('tiktok_comment_id', comment.id)
          .single();
        
        if (existing) continue; // Skip duplicates
        
        // 6. Apply filters
        const matchedKeywords = matchesKeywords(comment.text, video.keywords || []);
        
        if (matchedKeywords.length > 0) {
          console.log(`✓ Match found: "${comment.text.substring(0, 30)}..."`);
          
          // 7. Create Zendesk ticket
          const ticketId = await createZendeskTicket(
            comment, 
            video.tiktok_url, 
            matchedKeywords
          );
          
          if (ticketId) {
            // 8. Record as processed
            await supabase
              .from('processed_comments')
              .insert({
                tiktok_comment_id: comment.id,
                video_id: video.id,
                zendesk_ticket_id: ticketId,
                comment_text: comment.text,
                matched_keywords: matchedKeywords
              });
            
            processedCount++;
          }
        }
      }
      
      // Update last_checked time
      await supabase
        .from('monitored_videos')
        .update({ last_checked: new Date().toISOString() })
        .eq('id', video.id);
    }
    
    res.json({ 
      success: true, 
      message: `Processed ${processedCount} new comments`,
      videos_checked: videos.length 
    });
    
  } catch (error) {
    console.error('CRITICAL ERROR:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
};