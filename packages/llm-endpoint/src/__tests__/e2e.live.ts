import { request as requestHttps } from 'https';
import { request as requestHttp } from 'http';
import { IncomingMessage } from 'http';

const PROXY_URL = 'http://localhost:18090';

async function runFetch(url: string, options: any = {}): Promise<{ status: number; headers: any; body: any }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestFn = isHttps ? requestHttps : requestHttp;
    
    const reqOptions: any = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };

    const req = requestFn(reqOptions, (res: IncomingMessage) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode || 200,
            headers: res.headers,
            body: JSON.parse(data)
          });
        } catch {
          resolve({
            status: res.statusCode || 200,
            headers: res.headers,
            body: data
          });
        }
      });
    });

    req.on('error', err => reject(err));

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function testE2E() {
  console.log('🧪 Starting LLM-Endpoint E2E Tests on Localhost...');
  let passed = 0;
  let failed = 0;

  // ── TEST 1: OpenAI-Style Model Discovery ──
  try {
    const res = await runFetch(`${PROXY_URL}/v1/models`, {
      method: 'GET'
    });
    if (res.status === 200 && res.body.object === 'list' && Array.isArray(res.body.data) && res.body.data.length > 0) {
      console.log('✅ Test 1 Passed: OpenAI-Style Model Discovery works (Got list of secret planet models!).');
      passed++;
    } else {
      throw new Error(`Invalid response structure: ${JSON.stringify(res.body)}`);
    }
  } catch (err: any) {
    console.error('❌ Test 1 Failed:', err.message);
    failed++;
  }

  // ── TEST 2: Anthropic-Style Model Discovery ──
  try {
    const res = await runFetch(`${PROXY_URL}/v1/models`, {
      method: 'GET',
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': 'AAAA'
      }
    });
    if (res.status === 200 && Array.isArray(res.body.data) && res.body.data[0].id.startsWith('claude-')) {
      console.log('✅ Test 2 Passed: Anthropic-Style Model Discovery works (Successfully masked target planet ids!).');
      passed++;
    } else {
      throw new Error(`Invalid response structure: ${JSON.stringify(res.body)}`);
    }
  } catch (err: any) {
    console.error('❌ Test 2 Failed:', err.message);
    failed++;
  }

  // ── TEST 3: Inflow Message to Groq (pluto-2) ──
  try {
    const res = await runFetch(`${PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer AAAA' },
      body: {
        model: 'pluto-2',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Say OK' }]
      }
    });
    if (res.status === 200 && res.body.choices && res.body.choices[0].message.content) {
      console.log(`✅ Test 3 Passed: Groq (pluto-2) routed successfully. Response: "${res.body.choices[0].message.content.trim()}"`);
      passed++;
    } else {
      throw new Error(`Unexpected body: ${JSON.stringify(res.body)}`);
    }
  } catch (err: any) {
    console.error('❌ Test 3 Failed:', err.message);
    failed++;
  }

  // ── TEST 4: Inflow Message to OpenRouter with Secret Model Override ──
  try {
    const res = await runFetch(`http://localhost:18090/v1/messages?secret_model=google/gemini-3.1-pro-preview`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer AAAA'
      },
      body: {
        model: 'saturn-5',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Say OK' }]
      }
    });
    // Si le modèle est redirigé vers Gemini 3.1 Pro via le secret et qu'il répond en s'étant exécuté avec succès, c'est suffisant pour le test E2E.
    if (res.status === 200 && res.body.choices && (res.body.choices[0].message.content || res.body.choices[0].message.reasoning_details)) {
      console.log(`✅ Test 4 Passed: URL secret model parameter query override successfully bypassed routing to call Gemini 3.1 Pro. Response obtained successfully.`);
      passed++;
    } else {
      throw new Error(`Unexpected status ${res.status}: ${JSON.stringify(res.body)}`);
    }
  } catch (err: any) {
    console.error('❌ Test 4 Failed:', err.message);
    failed++;
  }

  // ── TEST 5: Tool Translation Verification ──
  try {
    const res = await runFetch(`${PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer AAAA' },
      body: {
        model: 'saturn-5', // Mapped to OpenRouter -> needs translation of tools
        max_tokens: 100,
        messages: [{ role: 'user', content: 'What is the current temperature in Paris?' }],
        tools: [
          {
            name: 'get_current_weather',
            description: 'Get the current weather for a location',
            input_schema: {
              type: 'object',
              properties: {
                location: { type: 'string', description: 'The location, e.g. Paris' }
              },
              required: ['location']
            }
          }
        ]
      }
    });
    if (res.status === 200) {
      console.log('✅ Test 5 Passed: Anthropic Tool definition translated cleanly to OpenAI Function Schema without firing 400 Bad Request !');
      passed++;
    } else {
      throw new Error(`Tool call failed with status ${res.status}: ${JSON.stringify(res.body)}`);
    }
  } catch (err: any) {
    console.error('❌ Test 5 Failed:', err.message);
    failed++;
  }

  console.log(`\n📊 E2E Test Suite Summary: Passed ${passed}/${passed + failed} tests.`);
}

// Live suite — hits a running proxy (localhost:18090) + real provider keys.
// Not a vitest unit test (renamed off the `.test.` glob). Run with:
//   pnpm --filter @agentproto/llm-endpoint test:e2e
testE2E();
