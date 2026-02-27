/**
 * Setup:
 * 1) npm install axios cheerio csv-writer
 * 2) Run: node script.js
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { createObjectCsvWriter } = require('csv-writer');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Listing pages to scrape.
const LISTING_URLS = [
  'https://www.a-star.edu.sg/sign/people',
  'https://www.a-star.edu.sg/asrl/principal-investigators',
  'https://www.a-star.edu.sg/idlabs/people/Investigators',
  'https://www.a-star.edu.sg/idlabs/people/programme-leads',
  'https://www.a-star.edu.sg/idlabs/people/scientists',
  'https://www.a-star.edu.sg/idlabs/people/adjunct-investigators'
];

// Generic link texts that should be excluded when discovering profile links.
const GENERIC_TEXTS = new Set([
  'about',
  'people',
  'scientists',
  'investigators',
  'programme leads',
  'program leads',
  'programmes',
  'publications',
  'contact',
  'news',
  'events',
  'research',
  'home',
  'read more',
  'view all'
]);

// Small sleep helper for retry backoff.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch HTML with retry support.
 */
async function fetchWithRetry(url, retries = 3, delayMs = 1200) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.get(url, {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AStarScraperTest/1.0)'
        }
      });
      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(delayMs * attempt);
      }
    }
  }
  throw lastError;
}

/**
 * Convert possibly relative URL to absolute URL.
 */
function toAbsoluteUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Infer affiliation from listing URL path only.
 */
function inferAffiliation(listingUrl) {
  const lower = listingUrl.toLowerCase();
  if (lower.includes('/sign/')) return 'Singapore Immunology Network (SIgN)';
  if (lower.includes('/asrl/')) return 'A*STAR Skin Research Labs (ASRL)';
  if (lower.includes('/idlabs/')) return 'Infectious Diseases Labs (ID Labs)';
  return 'N.A.';
}

/**
 * Infer organization from listing URL path only.
 */
function inferOrganization(listingUrl) {
  if (listingUrl.toLowerCase().includes('adjunct-investigators')) {
    return 'Adjunct: A*STAR';
  }
  return 'A*STAR';
}

/**
 * Decide if a link appears to be an investigator profile link.
 */
function isLikelyPersonName(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return false;

  const words = cleaned.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  // Menu labels are often long phrases and include special characters.
  if (/[*|:;!?]/.test(cleaned)) return false;

  // Avoid obvious non-person labels.
  const lower = cleaned.toLowerCase();
  if (
    lower.includes('welcome message') ||
    lower.includes('workplace commitments') ||
    lower.includes('origins') ||
    lower.includes('history') ||
    lower.includes('mission')
  ) {
    return false;
  }

  // Require alphabetic words and avoid phrase-like all-lowercase labels.
  const alphaWordCount = words.filter((w) => /[a-z]/i.test(w)).length;
  if (alphaWordCount < 2) return false;
  if (cleaned === lower) return false;

  return true;
}

function isLikelyProfileLink(anchorText, absoluteUrl, listingUrl, hasImageContext = false) {
  if (!absoluteUrl) return false;

  const text = (anchorText || '').replace(/\s+/g, ' ').trim();
  const lowerText = text.toLowerCase();

  // Exclude empty/generic/fully-uppercase menu-like labels.
  if (!text) return false;
  if (GENERIC_TEXTS.has(lowerText)) return false;
  if (text.length <= 2) return false;
  if (text === text.toUpperCase() && /[A-Z]/.test(text)) return false;

  // Person links on these pages are photo cards with name labels.
  if (!hasImageContext) return false;
  if (!isLikelyPersonName(text)) return false;

  let linkUrl;
  let listUrl;
  try {
    linkUrl = new URL(absoluteUrl);
    listUrl = new URL(listingUrl);
  } catch {
    return false;
  }

  // Keep only same host profile pages.
  if (linkUrl.hostname !== listUrl.hostname) return false;

  const pathname = linkUrl.pathname.toLowerCase();

  // Exclude obvious non-profile/document/navigation targets.
  if (pathname.endsWith('.pdf') || pathname.endsWith('.doc') || pathname.endsWith('.docx')) return false;
  if (pathname.includes('/news') || pathname.includes('/event') || pathname.includes('/publication')) return false;

  // Exclude exact listing page or category pages.
  const listPath = listUrl.pathname.toLowerCase().replace(/\/+$/, '');
  const linkPath = pathname.replace(/\/+$/, '');
  if (linkPath === listPath) return false;

  // Must be deeper than listing path and not just a category token.
  const linkSegments = linkPath.split('/').filter(Boolean);
  const listSegments = listPath.split('/').filter(Boolean);
  if (linkSegments.length <= listSegments.length) return false;

  const lastSegment = linkSegments[linkSegments.length - 1];
  if (GENERIC_TEXTS.has(lastSegment.replace(/-/g, ' '))) return false;

  return true;
}

/**
 * Extract first two valid investigator profile links from one listing page.
 */
async function extractProfileLinks(listingUrl) {
  const html = await fetchWithRetry(listingUrl);
  const $ = cheerio.load(html);

  const links = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    if (links.length >= 2) return;

    const href = $(el).attr('href');
    const text = $(el).text();
    const absolute = toAbsoluteUrl(listingUrl, href);

    const hasImageContext =
      $(el).find('img').length > 0 ||
      $(el).siblings('img').length > 0 ||
      $(el).parent().find('img').length > 0 ||
      $(el).closest('article, li, div, section').find('img').length > 0;

    if (!isLikelyProfileLink(text, absolute, listingUrl, hasImageContext)) return;
    if (seen.has(absolute)) return;

    seen.add(absolute);
    links.push({ url: absolute, anchorText: (text || '').trim() });
  });

  return links.slice(0, 2);
}

/**
 * Get clean text from a cheerio selection.
 */
function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Build focused text snippets from profile HTML so the LLM sees contextual signals
 * without sending the full document.
 */
function buildContextForAi($) {
  const pageTitle = cleanText($('title').first().text());

  const headings = [];
  $('h1, h2, h3, h4').each((_, el) => {
    const txt = cleanText($(el).text());
    if (txt && txt.length <= 140) headings.push(txt);
  });

  const bodyParagraphs = [];
  $('main p, article p, section p, p, li').each((_, el) => {
    const txt = cleanText($(el).text());
    if (!txt) return;
    if (txt.length < 25 || txt.length > 420) return;
    bodyParagraphs.push(txt);
  });

  const links = [];
  $('a[href]').each((_, el) => {
    const href = cleanText($(el).attr('href') || '');
    if (!href || /^mailto:/i.test(href)) return;
    const text = cleanText($(el).text());
    links.push({ text: text || 'N.A.', href });
  });

  return {
    pageTitle,
    headings: headings.slice(0, 30),
    paragraphs: bodyParagraphs.slice(0, 60),
    links: links.slice(0, 80)
  };
}

/**
 * Ask OpenAI to summarize role/research and pick best LinkedIn/lab URL candidates.
 */
async function summarizeProfileWithOpenAi(context, profileUrl) {
  if (!OPENAI_API_KEY) {
    return {
      jobTitle: 'N.A.',
      researchInterest: 'N.A.',
      linkedIn: 'N.A.',
      labWebpage: 'N.A.'
    };
  }

  const inputPayload = {
    sourceUrl: profileUrl,
    pageTitle: context.pageTitle,
    headings: context.headings,
    paragraphs: context.paragraphs,
    links: context.links
  };

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You extract structured profile data from academic profile pages. Return strict JSON only with keys: jobTitle, researchInterest, linkedIn, labWebpage. If unknown, use "N.A.". Use URLs exactly as seen in links when possible.'
        },
        {
          role: 'user',
          content: `Use this context from a profile page and infer the best values. Prefer explicit evidence and concise summaries. Context: ${JSON.stringify(inputPayload)}`
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  const rawContent =
    response.data &&
    response.data.choices &&
    response.data.choices[0] &&
    response.data.choices[0].message &&
    response.data.choices[0].message.content;

  let parsed;
  try {
    parsed = JSON.parse(rawContent || '{}');
  } catch {
    parsed = {};
  }

  return {
    jobTitle: cleanText(parsed.jobTitle) || 'N.A.',
    researchInterest: cleanText(parsed.researchInterest) || 'N.A.',
    linkedIn: cleanText(parsed.linkedIn) || 'N.A.',
    labWebpage: cleanText(parsed.labWebpage) || 'N.A.'
  };
}

/**
 * Extract name from profile page with simple deterministic rules.
 */
function extractName($, fallbackText = 'N.A.') {
  const h1 = cleanText($('h1').first().text());
  if (h1) return h1;

  const selectors = [
    '[class*="name"]',
    '[class*="profile"] [class*="title"]',
    '.person-name',
    '.profile-name'
  ];

  for (const sel of selectors) {
    const txt = cleanText($(sel).first().text());
    if (txt && txt.split(' ').length >= 2) return txt;
  }

  return fallbackText;
}

/**
 * Extract all job titles that appear explicitly on the profile page.
 */
function extractJobTitles($, fullName) {
  const titles = new Set();

  const candidateSelectors = [
    '[class*="title"]',
    '[class*="designation"]',
    '[class*="position"]',
    '[class*="role"]',
    'p',
    'li',
    'div'
  ];

  candidateSelectors.forEach((selector) => {
    $(selector).each((_, el) => {
      const txt = cleanText($(el).text());
      if (!txt || txt === fullName) return;

      // Capture explicit title-like lines.
      if (
        /^title\s*:/i.test(txt) ||
        /^designation\s*:/i.test(txt) ||
        /^position\s*:/i.test(txt) ||
        /\b(principal investigator|investigator|scientist|professor|associate professor|assistant professor|director|lead|fellow|clinician scientist|senior scientist)\b/i.test(txt)
      ) {
        // Avoid very long paragraphs that are unlikely to be title fields.
        if (txt.length <= 160) {
          titles.add(txt.replace(/^(title|designation|position)\s*:/i, '').trim());
        }
      }
    });
  });

  return titles.size ? Array.from(titles).join('; ') : 'N.A.';
}

/**
 * Extract a short explicit research interest paragraph when available.
 */
function extractResearchInterest($) {
  const headingMatchers = ['research interest', 'research interests'];

  for (const matcher of headingMatchers) {
    const heading = $('h1, h2, h3, h4, h5, strong, b, p, div')
      .filter((_, el) => cleanText($(el).text()).toLowerCase() === matcher)
      .first();

    if (heading.length) {
      // Try next paragraph/list item/div as the content.
      const next = heading.nextAll('p, div, li').first();
      const nextText = cleanText(next.text());
      if (nextText) return nextText;
    }
  }

  // Handle inline format like: "Research Interest: ..."
  let inlineFound = 'N.A.';
  $('p, div, li').each((_, el) => {
    const txt = cleanText($(el).text());
    const match = txt.match(/^research interests?\s*:\s*(.+)$/i);
    if (match && cleanText(match[1])) {
      inlineFound = cleanText(match[1]);
      return false;
    }
    return undefined;
  });

  return inlineFound;
}

/**
 * Extract profile data from one investigator page.
 */
async function scrapeProfile(profileUrl, listingUrl, fallbackName = 'N.A.') {
  const html = await fetchWithRetry(profileUrl);
  const $ = cheerio.load(html);

  const fullName = extractName($, fallbackName);

  // Email from explicit mailto only.
  const emailHref = $('a[href^="mailto:"]').first().attr('href') || '';
  const workEmail = emailHref ? cleanText(emailHref.replace(/^mailto:/i, '').split('?')[0]) : 'N.A.';

  // LinkedIn from explicit link only (deterministic fallback).
  let linkedIn = 'N.A.';
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/linkedin\.com/i.test(href)) {
      linkedIn = toAbsoluteUrl(profileUrl, href) || href;
      return false;
    }
    return undefined;
  });

  // Lab webpage from explicit link text/href only (deterministic fallback).
  let labWebpage = 'N.A.';
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = cleanText($(el).text()).toLowerCase();
    if (/^mailto:/i.test(href)) return;
    if (/linkedin\.com/i.test(href)) return;

    if (text.includes('lab') || text.includes('laboratory') || text.includes('research group') || /\blab\b/i.test(href)) {
      const absolute = toAbsoluteUrl(profileUrl, href);
      if (absolute) {
        labWebpage = absolute;
        return false;
      }
    }
    return undefined;
  });

  const deterministicJobTitle = extractJobTitles($, fullName);
  const deterministicResearchInterest = extractResearchInterest($);

  const context = buildContextForAi($);
  let aiSummary = {
    jobTitle: 'N.A.',
    researchInterest: 'N.A.',
    linkedIn: 'N.A.',
    labWebpage: 'N.A.'
  };

  try {
    aiSummary = await summarizeProfileWithOpenAi(context, profileUrl);
  } catch (error) {
    console.warn(`OpenAI summary unavailable for ${profileUrl}: ${error.message}`);
  }

  const jobTitle = aiSummary.jobTitle !== 'N.A.' ? aiSummary.jobTitle : deterministicJobTitle;
  const researchInterest =
    aiSummary.researchInterest !== 'N.A.' ? aiSummary.researchInterest : deterministicResearchInterest;

  if (aiSummary.linkedIn !== 'N.A.') {
    linkedIn = toAbsoluteUrl(profileUrl, aiSummary.linkedIn) || aiSummary.linkedIn;
  }

  if (aiSummary.labWebpage !== 'N.A.') {
    labWebpage = toAbsoluteUrl(profileUrl, aiSummary.labWebpage) || aiSummary.labWebpage;
  }

  return {
    fullName,
    workEmail: workEmail || 'N.A.',
    sourceUrl: profileUrl,
    jobTitle,
    linkedIn,
    labWebpage,
    researchInterest,
    affiliation: inferAffiliation(listingUrl),
    organization: inferOrganization(listingUrl)
  };
}

/**
 * Split full name into given and family names.
 */
function splitName(fullName) {
  const cleaned = cleanText(fullName);
  if (!cleaned || cleaned === 'N.A.') {
    return { givenName: 'N.A.', familyName: 'N.A.' };
  }

  const parts = cleaned.split(' ');
  if (parts.length === 1) {
    return { givenName: cleaned, familyName: 'N.A.' };
  }

  return {
    givenName: parts.slice(0, -1).join(' '),
    familyName: parts[parts.length - 1]
  };
}

/**
 * Merge duplicate investigator records by exact full-name match.
 */
function mergeDuplicate(existing, incoming) {
  const mergedTitles = new Set();

  if (existing.jobTitle && existing.jobTitle !== 'N.A.') {
    existing.jobTitle.split(';').map((t) => cleanText(t)).filter(Boolean).forEach((t) => mergedTitles.add(t));
  }
  if (incoming.jobTitle && incoming.jobTitle !== 'N.A.') {
    incoming.jobTitle.split(';').map((t) => cleanText(t)).filter(Boolean).forEach((t) => mergedTitles.add(t));
  }

  return {
    ...existing,
    jobTitle: mergedTitles.size ? Array.from(mergedTitles).join('; ') : 'N.A.',
    workEmail: existing.workEmail !== 'N.A.' ? existing.workEmail : incoming.workEmail,
    sourceUrl: existing.sourceUrl !== 'N.A.' ? existing.sourceUrl : incoming.sourceUrl,
    researchInterest: existing.researchInterest !== 'N.A.' ? existing.researchInterest : incoming.researchInterest,
    linkedIn: existing.linkedIn !== 'N.A.' ? existing.linkedIn : incoming.linkedIn,
    labWebpage: existing.labWebpage !== 'N.A.' ? existing.labWebpage : incoming.labWebpage,
    affiliation: existing.affiliation !== 'N.A.' ? existing.affiliation : incoming.affiliation,
    organization: existing.organization !== 'N.A.' ? existing.organization : incoming.organization
  };
}

/**
 * Main execution flow.
 */
async function main() {
  const byName = new Map();

  for (const listingUrl of LISTING_URLS) {
    console.log(`Processing listing page: ${listingUrl}`);

    try {
      const profileLinks = await extractProfileLinks(listingUrl);

      for (const link of profileLinks) {
        try {
          const record = await scrapeProfile(link.url, listingUrl, link.anchorText || 'N.A.');
          const key = record.fullName;

          if (byName.has(key)) {
            byName.set(key, mergeDuplicate(byName.get(key), record));
          } else {
            byName.set(key, record);
          }

          console.log(`Processed: ${record.fullName}`);
        } catch (error) {
          console.error(`Error processing ${link.url}: ${error.message}`);
        }
      }
    } catch (error) {
      console.error(`Error processing ${listingUrl}: ${error.message}`);
    }
  }

  const investigators = Array.from(byName.values());

  const rows = investigators.map((item) => {
    const { givenName, familyName } = splitName(item.fullName);
    return {
      givenName,
      familyName,
      jobTitle: item.jobTitle || 'N.A.',
      workEmail: item.workEmail || 'N.A.',
      source: item.sourceUrl || 'N.A.',
      researchInterest: item.researchInterest || 'N.A.',
      linkedIn: item.linkedIn || 'N.A.',
      labWebpage: item.labWebpage || 'N.A.',
      affiliation: item.affiliation || 'N.A.',
      organization: item.organization || 'N.A.'
    };
  });

  const csvWriter = createObjectCsvWriter({
    path: 'investigators_test_output.csv',
    header: [
      { id: 'givenName', title: 'Given name' },
      { id: 'familyName', title: 'Family name' },
      { id: 'jobTitle', title: 'Job title' },
      { id: 'workEmail', title: 'Work email' },
      { id: 'source', title: 'Source of information (URL)' },
      { id: 'researchInterest', title: 'Research interest' },
      { id: 'linkedIn', title: 'LinkedIn Profile' },
      { id: 'labWebpage', title: 'Lab webpage' },
      { id: 'affiliation', title: 'Affiliation' },
      { id: 'organization', title: 'Organization' }
    ]
  });

  await csvWriter.writeRecords(rows);
  console.log(`Completed. Total investigators processed: ${investigators.length}`);
}

main().catch((error) => {
  console.error(`Error processing script: ${error.message}`);
});
