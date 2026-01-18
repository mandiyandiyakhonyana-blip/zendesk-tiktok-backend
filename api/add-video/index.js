const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  // Add CORS headers for the response
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    // Because we are sending text/plain to bypass the CORS 405 error,
    // we must parse the string back into a JSON object manually.
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { tiktokUrl, keywords } = body;

    if (!tiktokUrl) throw new Error("Missing TikTok URL");

    const { error } = await supabase.from('monitored_videos').insert([
      { tiktok_url: tiktokUrl, keywords, is_active: true }
    ]);

    if (error) throw error;

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("API Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
};