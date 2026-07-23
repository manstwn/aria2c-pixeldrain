const axios = require('axios');
const https = require('https');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  console.log('1. Fetching wt.obf.js...');
  const wtScript = await fetchText('https://gofile.io/dist/js/wt.obf.js');
  
  console.log('2. Creating guest account...');
  const accountRes = await axios.post('https://api.gofile.io/accounts', {}, {
    headers: { 'Origin': 'https://gofile.io', 'User-Agent': USER_AGENT }
  });
  const guestToken = accountRes.data.data.token;
  console.log('   Guest token:', guestToken.substring(0, 10) + '...');

  console.log('3. Executing wt.obf.js to get generateWT function...');
  let generateWT = null;
  try {
    // Provide fake browser globals and run the obfuscated script
    const mockWindow = { appdata: { wt: '4fd6sg89d7s6' } };
    const fn = new Function(
      'window', 'self', 'globalThis', 'document',
      wtScript + '; return typeof generateWT !== "undefined" ? generateWT : null;'
    );
    generateWT = fn(mockWindow, mockWindow, mockWindow, {});
    console.log('   generateWT found:', typeof generateWT);
  } catch(e) {
    console.log('   Error:', e.message);
  }

  if (!generateWT) {
    console.log('Could not get generateWT. Trying with just token...');
  }

  const xWebsiteToken = generateWT ? generateWT(guestToken) : '4fd6sg89d7s6';
  console.log('4. X-Website-Token:', xWebsiteToken);

  console.log('5. Calling contents API...');
  try {
    const res = await axios.get('https://api.gofile.io/contents/U7h3RA', {
      params: { page: 1, pageSize: 1000 },
      headers: {
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${guestToken}`,
        'X-Website-Token': xWebsiteToken,
        'X-BL': 'en-US',
        'Origin': 'https://gofile.io',
        'Referer': 'https://gofile.io/d/U7h3RA'
      }
    });
    console.log('SUCCESS!');
    console.log(JSON.stringify(res.data, null, 2));
  } catch(e) {
    console.log('Error:', e.response?.data || e.message);
  }
}

main().catch(console.error);
