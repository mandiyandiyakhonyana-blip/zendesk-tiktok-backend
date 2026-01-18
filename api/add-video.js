const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  // 1. Handle CORS Preflight
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // If the browser is just "checking" the connection (OPTIONS), stop here and say OK
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 2. Only allow POST for actual data saving
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { tiktokUrl, keywords } = req.body;

    if (!tiktokUrl) {
      return res.status(400).json({ error: 'TikTok URL is required' });
    }

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
    console.error('Supabase Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};