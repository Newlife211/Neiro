// Рекламные платформы и публикации в соцсетях.
// Правило для всех платформ: кампания создаётся ВЫКЛЮЧЕННОЙ, включает её сервер только в рамках
// одобренного директором бюджета теста (см. marketing.js). Ключи — только из переменных окружения.

export function adsConfig(env = process.env) {
  return {
    meta: {
      token: env.META_ACCESS_TOKEN || '', adAccount: env.META_AD_ACCOUNT_ID || '', pageId: env.META_PAGE_ID || '',
      version: env.META_API_VERSION || 'v23.0', currency: (env.META_CURRENCY || '').toUpperCase(),
    },
    google: {
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN || '', clientId: env.GOOGLE_ADS_CLIENT_ID || '', clientSecret: env.GOOGLE_ADS_CLIENT_SECRET || '',
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN || '', customerId: (env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, ''),
      loginCustomerId: (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, ''), version: env.GOOGLE_ADS_API_VERSION || 'v21',
      currency: (env.GOOGLE_ADS_CURRENCY || '').toUpperCase(),
    },
    instagram: { userId: env.IG_USER_ID || '', token: env.IG_ACCESS_TOKEN || env.META_ACCESS_TOKEN || '', version: env.META_API_VERSION || 'v23.0' },
    linkedin: { token: env.LINKEDIN_ACCESS_TOKEN || '', orgUrn: env.LINKEDIN_ORG_URN || '', version: env.LINKEDIN_VERSION || '202510' },
    telegramChannel: env.TELEGRAM_CHANNEL_ID || '',
  };
}

// Каналы. api — есть автоматизация через API; остальные ведутся вручную, цифры вносятся через mk_log.
export const CHANNELS = {
  google: { title: 'Google Ads (поиск)', api: 'google' },
  meta: { title: 'Meta (Facebook/Instagram)', api: 'meta' },
  tiktok: { title: 'TikTok Ads', api: null },
  linkedin: { title: 'LinkedIn Ads', api: null },
  yandex: { title: 'Яндекс Директ', api: null },
  outreach: { title: 'Личная переписка', api: null },
  email: { title: 'Письма', api: null },
  community: { title: 'Сообщества и форумы', api: null },
  telegram: { title: 'Telegram', api: null },
  instagram: { title: 'Instagram (органика)', api: null },
  seo: { title: 'Статьи и поиск', api: null },
  producthunt: { title: 'Каталоги и запуски', api: null },
  partners: { title: 'Партнёры и рефералы', api: null },
  other: { title: 'Другое', api: null },
};
export const normChannel = (s) => {
  const k = String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
  if (['facebook', 'fb', 'ig', 'metaads'].includes(k)) return 'meta';
  if (['googleads', 'adwords', 'gads'].includes(k)) return 'google';
  return k || 'direct';
};

function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  return p;
}

// ---------------- Meta Marketing API ----------------
export function metaAds(c, fetchImpl = fetch) {
  const enabled = !!(c.token && c.adAccount && c.pageId);
  const base = `https://graph.facebook.com/${c.version}`;
  const act = c.adAccount.startsWith('act_') ? c.adAccount : 'act_' + c.adAccount;
  async function call(method, path, params = {}) {
    if (!enabled) throw new Error('Meta не подключена (META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID)');
    const url = method === 'GET' ? `${base}${path}?${form({ ...params, access_token: c.token })}` : `${base}${path}`;
    const r = await fetchImpl(url, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ ...params, access_token: c.token }).toString() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error('Meta: ' + (j.error?.error_user_msg || j.error?.message || r.status));
    return j;
  }
  return {
    enabled,
    // spec: {name, dailyBudgetMinor, countries[], ageMin, ageMax, url, creatives:[{headline,text,description,image_url}], endTime}
    async createCampaign(s) {
      const camp = await call('POST', `/${act}/campaigns`, { name: s.name, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false });
      // Набор объявлений и объявления — активны, а кампания выключена: показы управляются одним выключателем кампании.
      const adset = await call('POST', `/${act}/adsets`, {
        name: s.name + ' · аудитория', campaign_id: camp.id, daily_budget: s.dailyBudgetMinor, billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', status: 'ACTIVE', end_time: s.endTime,
        targeting: { geo_locations: { countries: s.countries?.length ? s.countries : ['DE'] }, age_min: s.ageMin || 18, age_max: s.ageMax || 65 },
      });
      const ads = [];
      for (const [i, cr] of (s.creatives || []).slice(0, 5).entries()) {
        const creative = await call('POST', `/${act}/adcreatives`, { name: `${s.name} · креатив ${i + 1}`,
          object_story_spec: { page_id: c.pageId, link_data: { link: s.url, message: cr.text, name: cr.headline, description: cr.description, picture: cr.image_url, call_to_action: { type: 'LEARN_MORE', value: { link: s.url } } } } });
        const ad = await call('POST', `/${act}/ads`, { name: `${s.name} · объявление ${i + 1}`, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'ACTIVE' });
        ads.push(ad.id);
      }
      return { extId: camp.id, extra: { adset_id: adset.id, ad_ids: ads } };
    },
    async setStatus(extId, active) { await call('POST', `/${extId}`, { status: active ? 'ACTIVE' : 'PAUSED' }); },
    async setDailyBudget(extId, extra, minor) { await call('POST', `/${extra.adset_id}`, { daily_budget: minor }); },
    async insights(extIds, since, until) {
      if (!extIds.length) return [];
      const j = await call('GET', `/${act}/insights`, { level: 'campaign', fields: 'campaign_id,impressions,inline_link_clicks,spend,account_currency', time_increment: 1,
        time_range: { since, until }, filtering: [{ field: 'campaign.id', operator: 'IN', value: extIds }], limit: 500 });
      return (j.data || []).map((x) => ({ extId: String(x.campaign_id), day: x.date_start, impressions: Number(x.impressions) || 0, clicks: Number(x.inline_link_clicks) || 0, spend: Number(x.spend) || 0, currency: x.account_currency }));
    },
  };
}

// ---------------- Google Ads API (REST) ----------------
export function googleAds(c, fetchImpl = fetch) {
  const enabled = !!(c.developerToken && c.clientId && c.clientSecret && c.refreshToken && c.customerId);
  let token = null, tokenExp = 0;
  const cid = c.customerId;
  async function auth() {
    if (token && Date.now() < tokenExp) return token;
    const r = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken }).toString() });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error('Google OAuth: ' + (j.error_description || j.error || r.status));
    token = j.access_token; tokenExp = Date.now() + ((j.expires_in || 3600) - 120) * 1000;
    return token;
  }
  async function call(path, body) {
    if (!enabled) throw new Error('Google Ads не подключён (GOOGLE_ADS_* в .env)');
    const h = { Authorization: 'Bearer ' + (await auth()), 'developer-token': c.developerToken, 'Content-Type': 'application/json' };
    if (c.loginCustomerId) h['login-customer-id'] = c.loginCustomerId;
    const r = await fetchImpl(`https://googleads.googleapis.com/${c.version}/customers/${cid}${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Google Ads: ' + (j.error?.details?.[0]?.errors?.[0]?.message || j.error?.message || r.status));
    return j;
  }
  const rn = (type, id) => `customers/${cid}/${type}/${id}`;
  return {
    enabled,
    // spec: {name, dailyBudgetMicros, url, keywords[], headlines[], descriptions[], geoTargetIds[], languageIds[]}
    async createCampaign(s) {
      const ops = [
        { campaignBudgetOperation: { create: { resourceName: rn('campaignBudgets', -1), name: s.name + ' · бюджет ' + Date.now(), amountMicros: String(s.dailyBudgetMicros), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
        { campaignOperation: { create: { resourceName: rn('campaigns', -2), name: s.name, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: rn('campaignBudgets', -1),
          targetSpend: {}, networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false }, containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING' } } },
        ...(s.geoTargetIds || []).map((g) => ({ campaignCriterionOperation: { create: { campaign: rn('campaigns', -2), location: { geoTargetConstant: `geoTargetConstants/${g}` } } } })),
        ...(s.languageIds || []).map((l) => ({ campaignCriterionOperation: { create: { campaign: rn('campaigns', -2), language: { languageConstant: `languageConstants/${l}` } } } })),
        { adGroupOperation: { create: { resourceName: rn('adGroups', -3), name: s.name + ' · группа', campaign: rn('campaigns', -2), status: 'ENABLED', type: 'SEARCH_STANDARD' } } },
        ...(s.keywords || []).slice(0, 50).map((k) => ({ adGroupCriterionOperation: { create: { adGroup: rn('adGroups', -3), status: 'ENABLED', keyword: { text: String(k).slice(0, 80), matchType: 'PHRASE' } } } })),
        { adGroupAdOperation: { create: { adGroup: rn('adGroups', -3), status: 'ENABLED', ad: { finalUrls: [s.url], responsiveSearchAd: {
          headlines: s.headlines.slice(0, 15).map((t) => ({ text: String(t).slice(0, 30) })), descriptions: s.descriptions.slice(0, 4).map((t) => ({ text: String(t).slice(0, 90) })) } } } } },
      ];
      const j = await call('/googleAds:mutate', { mutateOperations: ops });
      const res = j.mutateOperationResponses || [];
      const camp = res.find((x) => x.campaignResult)?.campaignResult?.resourceName || '';
      const budget = res.find((x) => x.campaignBudgetResult)?.campaignBudgetResult?.resourceName || '';
      if (!camp) throw new Error('Google Ads: кампания не создана');
      return { extId: camp.split('/').pop(), extra: { budget } };
    },
    async setStatus(extId, active) {
      await call('/googleAds:mutate', { mutateOperations: [{ campaignOperation: { update: { resourceName: rn('campaigns', extId), status: active ? 'ENABLED' : 'PAUSED' }, updateMask: 'status' } }] });
    },
    async setDailyBudget(extId, extra, micros) {
      await call('/googleAds:mutate', { mutateOperations: [{ campaignBudgetOperation: { update: { resourceName: extra.budget, amountMicros: String(micros) }, updateMask: 'amount_micros' } }] });
    },
    async insights(extIds, since, until) {
      if (!extIds.length) return [];
      const ids = extIds.filter((x) => /^\d+$/.test(x)).join(',');
      if (!ids) return [];
      const j = await call('/googleAds:search', { query: `SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE campaign.id IN (${ids}) AND segments.date BETWEEN '${since}' AND '${until}'` });
      return (j.results || []).map((x) => ({ extId: String(x.campaign.id), day: x.segments.date, impressions: Number(x.metrics.impressions) || 0, clicks: Number(x.metrics.clicks) || 0, spend: (Number(x.metrics.costMicros) || 0) / 1e6, currency: c.currency || null }));
    },
  };
}

// ---------------- Публикации: Instagram, LinkedIn, Telegram ----------------
export function socialPublisher(c, fetchImpl = fetch) {
  async function json(r, who) { const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(`${who}: ${j.error?.message || j.message || r.status}`); return j; }
  return {
    has: (net) => net === 'instagram' ? !!(c.instagram.userId && c.instagram.token) : net === 'linkedin' ? !!(c.linkedin.token && c.linkedin.orgUrn) : net === 'telegram' ? !!c.telegramChannel : false,
    async instagram({ text, image_url }) {
      if (!image_url) throw new Error('Instagram публикует только с картинкой: нужен image_url (публичная ссылка на JPG)');
      const base = `https://graph.facebook.com/${c.instagram.version}/${c.instagram.userId}`;
      const post = (path, p) => fetchImpl(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ ...p, access_token: c.instagram.token }).toString() });
      const media = await json(await post('/media', { image_url, caption: text }), 'Instagram');
      const pub = await json(await post('/media_publish', { creation_id: media.id }), 'Instagram');
      return { id: pub.id };
    },
    async linkedin({ text }) {
      const r = await fetchImpl('https://api.linkedin.com/rest/posts', { method: 'POST',
        headers: { Authorization: 'Bearer ' + c.linkedin.token, 'LinkedIn-Version': c.linkedin.version, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: c.linkedin.orgUrn, commentary: text, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false }) });
      if (!r.ok) await json(r, 'LinkedIn');
      return { id: r.headers?.get?.('x-restli-id') || null };
    },
  };
}
