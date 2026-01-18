const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // If the body is coming in as a string (text/plain), we must parse it
    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) { throw new Error("Invalid JSON body"); }
    }

    const { tiktokUrl, keywords } = body;

    if (!tiktokUrl) return res.status(400).json({ success: false, error: "Missing URL" });

    const { error } = await supabase.from('monitored_videos').insert([
      { tiktok_url: tiktokUrl, keywords, is_active: true }
    ]);

    if (error) throw error;
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};