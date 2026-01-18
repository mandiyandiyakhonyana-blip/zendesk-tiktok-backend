const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  // Allow all origins for the simple request
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // If we sent text/plain, parse it back to JSON
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { tiktokUrl, keywords } = body;

    const { error } = await supabase.from('monitored_videos').insert([
      { tiktok_url: tiktokUrl, keywords, is_active: true }
    ]);

    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};