'use strict';
/*
 * buildResumes.js — tailored-resume generator for job-pipeline candidates
 * (Track C, Oct 28, 2026).
 *
 * Sources: ONLY ~/workspace/macf/team-skills/jesse-biography.md and
 * ~/workspace/biography-research/desktop-canonical-resume-jesse.md.
 * Every bullet below is a true record item from those two files. Tailoring =
 * selecting, reordering, and rewording those items toward the posting's
 * keyword cluster; nothing is invented (no fabricated employers, dates,
 * metrics, budgets, or tool years).
 *
 * Usage: node buildResumes.js --candidates preview.json --out <dir>
 *   preview.json: { q: [ {company,title,location,salaryMin,salaryMax,url,slug} ] }
 *   Writes <dir>/<slug>/resume.md for each candidate.
 */
const fs = require('fs');
const path = require('path');

const CLUSTERS = [
  { key: 'ai', re: /\b(ai|artificial intelligence|automation|agentic|transformation|gtm)\b/i,
    headline: 'AI-Driven Growth & Marketing Automation',
    skills: ['AI/automation & multi-agent systems', 'growth hacking', 'social media strategy', 'demand generation', 'performance marketing', 'digital analytics (GA4)', 'content strategy', 'developer relations', 'Python / JavaScript / REST APIs', 'prompt engineering'] },
  { key: 'performance', re: /\b(performance|paid|programmatic|acquisition|ppc|media strategy|martech)\b/i,
    headline: 'Performance Marketing & Paid Acquisition',
    skills: ['performance marketing', 'growth hacking', 'digital analytics (GA4)', 'Facebook advertising', 'demand generation', 'lifecycle marketing', 'content strategy', 'social media strategy', 'brand strategy', 'community & creator partnerships'] },
  { key: 'demandgen', re: /\b(demand|pipeline|b2b|enterprise|abm|account based|revenue|product marketing|web product|website|gtm|go-to-market|operations)\b/i,
    headline: 'Demand Generation & B2B Growth',
    skills: ['demand generation', 'growth hacking', 'performance marketing', 'digital analytics (GA4)', 'lifecycle marketing', 'brand strategy', 'content strategy', 'social media strategy', 'AI/automation & multi-agent systems', 'developer relations'] },
  { key: 'content_social', re: /\b(content|social|brand|creator|organic|community|social commerce|audience)\b/i,
    headline: 'Content, Social Media & Brand Growth',
    skills: ['social media strategy', 'content marketing/strategy', 'brand strategy', 'growth hacking', 'community & creator/influencer partnerships', 'performance marketing', 'Facebook advertising', 'demand generation', 'lifecycle marketing', 'digital analytics (GA4)'] },
  { key: 'ecomm', re: /\b(ecomm|e-commerce|dtc|marketplace|retail|commerce)\b/i,
    headline: 'E-Commerce & DTC Growth Marketing',
    skills: ['growth hacking', 'performance marketing', 'social media strategy', 'content strategy', 'brand strategy', 'lifecycle marketing', 'demand generation', 'digital analytics (GA4)', 'Facebook advertising', 'community & creator partnerships'] },
];
const DEFAULT_CLUSTER = {
  key: 'growth', headline: 'Growth Marketing Leadership',
  skills: ['growth hacking', 'social media strategy', 'performance marketing', 'brand strategy', 'content strategy', 'demand generation', 'lifecycle marketing', 'digital analytics (GA4)', 'AI/automation & multi-agent systems', 'community & creator partnerships'],
};

function clusterFor(title) {
  for (const c of CLUSTERS) if (c.re.test(title)) return c;
  return DEFAULT_CLUSTER;
}

/* Experience blocks: [org line, dates line, bullets in canonical order].
 * The generator moves the cluster's lead block first after Stay N Alive and
 * reorders bullets so cluster-relevant ones lead. All text is drawn from the
 * two canonical sources. */
const BLOCKS = {
  staynalive: {
    head: "### Stay N' Alive — Founder; Chief Growth Hacker, Consultant & AI Automation Strategist",
    dates: 'Jun 2002 – Present | Remote',
    tags: ['ai', 'content_social', 'growth', 'ecomm', 'performance', 'demandgen'],
    bullets: [
      'Founded one of the earliest boutique social-media consultancies (running since 2002); ran the practice to $500K revenue in a year, advising clients including Facebook, MySpace, Ancestry.com, Pluralsight, and FamilyLink.',
      'Built and operates a production multi-agent AI system that runs day-to-day business operations — content, CRM, outreach, and pipeline work — coordinated through an executive dashboard he designed as the single source of truth.',
      'Built an AI social-content pipeline covering ideation, drafting, human approval, and scheduling across Facebook, X/Twitter, Instagram, TikTok, LinkedIn, Bluesky, and Threads, with tracking of what converts and cross-channel reuse of winning content.',
      'Authored/co-authored 13 books (O\u2019Reilly; Wiley/For Dummies) on Facebook, Google+, LinkedIn, Minecraft, Canva, and TikTok.',
      'Client results include FamilyLink reaching #1 app on Facebook, i.TV reaching #1 in the iOS App Store, and 1M+ page views on kred.com via social API integration.',
      'Architected an "AI Privacy Bridge" (forces PII/keys to local-only AI) and a multi-LLM model-routing layer across providers; currently building transkrybe.com, an AI sheet-music SaaS.',
    ],
  },
  hazelcast: {
    head: '### Hazelcast — Director of Web Marketing, Growth & Design',
    dates: 'Jan 2022 – Jan 2023 | Remote',
    tags: ['performance', 'demandgen', 'growth'],
    bullets: [
      'Delivered a 400% increase in web leads through GA4 persona mapping, real-time insights, and Mutiny A/B personalization.',
      'Doubled social-media-driven leads through referral-path analysis and intent-matched website personalization.',
      'Directed brand-to-web integration and full-funnel B2B demand generation and optimization, including behavioral triggers and iterative experimentation.',
    ],
  },
  uhg: {
    head: '### UnitedHealth Group / Optum (Fortune 5) — AI Automation Systems Engineer (Principal Data Analyst)',
    dates: 'Apr 2018 – Nov 2020 | Remote',
    tags: ['ai', 'demandgen'],
    bullets: [
      'Built scalable AI and automation infrastructure serving 50M+ members, producing $10M+ in annual operational savings, a 40% reduction in manual processing time, and a 25% customer-service efficiency gain.',
      'Proactively detected operational inefficiencies and translated performance data into next actions for executive audiences.',
    ],
  },
  our: {
    head: '### Operation Underground Railroad — Founding Team, Growth Strategy & Social Media',
    dates: 'Apr 2013 – Jul 2017 | Remote',
    tags: ['content_social', 'growth', 'ecomm'],
    bullets: [
      "Built the organization's social presence from zero to 2M+ followers using viral/growth-hacking frameworks he designed.",
      'Designed viral content and donor-acquisition systems for a mission-driven audience: acquisition, activation, and retention run as one system.',
    ],
  },
  deseret: {
    head: '### Deseret Digital Media — Director, Social Media Strategy & Growth Innovation',
    dates: 'Nov 2012 – May 2013 | Salt Lake City, UT',
    tags: ['content_social', 'growth', 'ecomm', 'performance'],
    bullets: [
      'Created the "Passion Pages" model — a portfolio of identity-based pages built before, and feeding, the content site — and led the FamilyShare.com launch through it, growing combined social following to 20M+.',
      'Made social the primary traffic driver; built and managed the social team; established KPI frameworks and editorial calendars.',
    ],
  },
  lds: {
    head: '### The Church of Jesus Christ of Latter-day Saints — Advisor & Social Media Architect',
    dates: 'Mar 2010 – Nov 2012 | Salt Lake City, UT',
    tags: ['content_social', 'ai'],
    bullets: [
      'Kicked off and ran all social media initiatives at global scale (tens of millions of members, 180+ countries, multi-lingual), including crisis-comms playbooks, community-moderation frameworks, and social listening.',
      'Unblocked a Legal-vetoed Facebook Login integration by building an API enforcement layer that automatically applied whatever privacy rules Legal configured — turning a policy veto into a configurable control surface — and shipped the integration.',
      'Launched social channels for BYU, DeseretBook.com, and City Creek Mall, with international growth in Asia, Eastern Europe, and Africa.',
    ],
  },
  facebook: {
    head: '### Facebook (Meta) — Growth Engineer & Technical Writer, Facebook Platform Team',
    dates: 'Aug 2009 – Oct 2009 | Contract | Remote',
    tags: ['ai', 'demandgen', 'growth'],
    bullets: [
      "Authored the Facebook Connect / Platform developer documentation used by thousands of third-party developers during Facebook Connect's launch.",
      'Helped establish viral platform patterns for how apps spread across the social graph; developed initial design specs for "We\u2019re Related," which reached #1 in the Facebook app store.',
    ],
  },
  socialtoo: {
    head: '### SocialToo.com — Founder & Growth Engineer',
    dates: 'Oct 2007 – Mar 2010 | Remote',
    tags: ['growth', 'content_social'],
    bullets: [
      'Solo founder-operator of one of the earliest Twitter automation / audience-management SaaS platforms (~100K users); invented auto-follow and auto-DM on Twitter and produced some of the first analytics for Twitter.',
    ],
  },
};
const ORDER = {
  ai: ['staynalive', 'uhg', 'hazelcast', 'facebook', 'deseret', 'our', 'lds', 'socialtoo'],
  performance: ['staynalive', 'hazelcast', 'deseret', 'our', 'uhg', 'lds', 'facebook', 'socialtoo'],
  demandgen: ['staynalive', 'hazelcast', 'uhg', 'facebook', 'deseret', 'our', 'lds', 'socialtoo'],
  content_social: ['staynalive', 'deseret', 'our', 'lds', 'hazelcast', 'facebook', 'socialtoo', 'uhg'],
  ecomm: ['staynalive', 'deseret', 'our', 'hazelcast', 'lds', 'uhg', 'facebook', 'socialtoo'],
  growth: ['staynalive', 'hazelcast', 'deseret', 'our', 'uhg', 'lds', 'facebook', 'socialtoo'],
};
const SUMMARY_LEAD = {
  ai: 'Growth and digital marketing director who builds AI-driven acquisition systems: he wrote the first Facebook Connect developer documentation on Facebook\u2019s Platform team during the Connect launch, and today builds and operates production multi-agent AI systems that run real marketing operations. At UnitedHealth Group he built AI/automation infrastructure serving 50M+ members; at Hazelcast he directed web marketing and growth to a 400% increase in web leads.',
  performance: 'Performance and growth marketing director who has built acquisition engines on both sides of the funnel: B2C audiences scaled to tens of millions and B2B demand generation measured in pipeline and leads. At Hazelcast, directed web marketing and growth to a 400% increase in web leads through GA4 persona mapping and A/B personalization; at Deseret Digital Media, created the Passion Pages model and led the FamilyShare.com launch to 20M+ followers.',
  demandgen: 'Demand generation and growth director with Fortune 50 operating experience (Facebook/Meta, UnitedHealth Group). At Hazelcast he delivered a 400% increase in web leads and doubled social-media-driven leads through full-funnel B2B optimization; at Deseret Digital Media he made social the primary traffic driver for FamilyShare.com (20M+ followers) with KPI frameworks he established.',
  content_social: 'Social media and content growth director who created the Passion Pages model at Deseret Digital Media and led the FamilyShare.com launch, growing combined social following to 20M+, and built Operation Underground Railroad\u2019s social presence from zero to 2M+ followers. He wrote the first Facebook Connect developer documentation at Facebook, is the author of 13 books including TikTok For Dummies and Canva For Dummies, and holds a 500K+ combined following across channels.',
  ecomm: 'Growth marketing director for audience-led commerce: at Deseret Digital Media he created the Passion Pages model — build the audience first, then distribute owned-site offers to it at zero marginal cost — and led FamilyShare.com to 20M+ followers. At Hazelcast he delivered a 400% increase in web leads through persona mapping and personalization, and he has run his own consultancy, Stay N Alive, since 2002.',
  growth: 'Growth marketing director and founder with Fortune 50 operating experience (Facebook/Meta, UnitedHealth Group): 400% increase in web leads at Hazelcast, FamilyShare.com scaled to 20M+ followers at Deseret Digital Media under a model he created, Operation Underground Railroad social built from zero to 2M+ followers, and a consultancy run since 2002 to $500K revenue in a year. Author of 13 books; 500K+ combined following across channels.',
};

function buildResume(cand) {
  const cl = clusterFor(cand.title || '');
  const band = cand.salaryMin || cand.salaryMax
    ? ` Posting band as listed in the alert: ${cand.salaryMin ? '$' + cand.salaryMin.toLocaleString('en-US') : '?'} – ${cand.salaryMax ? '$' + cand.salaryMax.toLocaleString('en-US') : '?'}.` : '';
  const lines = [
    '# JESSE STAY', '',
    'St. George, UT | jesse@staynalive.com | (801) 853-8339 | linkedin.com/in/facebook | staynalive.com', '',
    `## ${cand.title} — ${cl.headline}`, '',
    SUMMARY_LEAD[cl.key], '',
    `Tailored to the ${cand.title} posting at ${cand.company} (${cand.location || 'location as listed in the alert'}).${band}`, '',
    '## CORE SKILLS', '',
    cl.skills.join(' · '), '',
    '## EXPERIENCE', '',
  ];
  for (const key of ORDER[cl.key]) {
    const b = BLOCKS[key];
    lines.push(b.head, b.dates, '', ...b.bullets.map(x => '- ' + x), '');
  }
  lines.push(
    '## TEACHING', '',
    '### LDS Business College — Professor', '',
    '- Designed and taught SMM160, Social Media Advertising and Advocacy.', '',
    '## BOOKS (selected of 13 published)', '',
    '- *FBML Essentials* — O\u2019Reilly, 2008 (the first book published on the Facebook API)',
    '- *Facebook Application Development For Dummies* — Wiley, 2011',
    '- *TikTok For Dummies* — Wiley, 2021',
    '- *Canva For Dummies* — Wiley, 2025',
    '- Full list of 13 titles (Wiley/For Dummies, O\u2019Reilly, Happy About) available on request.', '',
    '## EDUCATION & CERTIFICATIONS', '',
    '- BS, Computer Information Systems — Strayer University, June 2005, Summa Cum Laude (GPA 4.0); Alpha Chi National Honor Society; minor in E-Business, Business Management & Marketing',
    '- Graphic Design Essentials — Canva, Oct 2024',
    '- Microsoft Agentic AI & Architecture — in progress (SimpliLearn, 2026)', '',
    '## RECOGNITION', '',
    '- Mashable: one of "20 Developers to Follow" and one of "10 Essential Entrepreneurs to Follow" on Twitter',
    '- OpenID Foundation\u2019s first tech writer (2010); VentureBeat covered his open-source WordPress-Connect plugin (2008)',
    '- 500K+ combined following across channels', '',
  );
  return lines.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const data = JSON.parse(fs.readFileSync(get('--candidates'), 'utf8'));
  const list = data.q || data;
  const outDir = get('--out');
  let n = 0;
  for (const cand of list) {
    const dir = path.join(outDir, cand.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'resume.md'), buildResume(cand));
    n++;
  }
  console.log('resumes written:', n, '->', outDir);
}

module.exports = { buildResume, clusterFor };
