const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  // Only allow POST requests
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const { tiktokUrl, keywords } = req.body;

    const { data, error } = await supabase
      .from('monitored_videos')
      .insert([
        { 
          tiktok_url: tiktokUrl, 
          keywords: keywords, 
          is_active: true 
        }
      ]);

    if (error) throw error;

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};