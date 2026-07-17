'use strict';

const TOPIC_LABELS = Object.freeze({
  health: 'Health',
  technology: 'Technology',
  engineering: 'Engineering',
  security: 'Security',
  culture: 'Culture',
  other: 'Other'
});

const TOPIC_BY_SLUG = Object.freeze({
  'alcohols-health-effects-latest-research': 'health',
  'autonomous-taxi-ai-state-and-future': 'technology',
  'black-peppers-absorption-enhancement-mechanisms': 'health',
  'bypassing-buffer-overflow-mitigations': 'security',
  'creatine-for-endometriosis-symptom-management': 'health',
  'drone-based-tdem-research-overview': 'engineering',
  'marijuana-consumption-effects-research': 'health',
  'muscle-growth-nutrient-requirements-explained': 'health',
  'music-taste-factors-and-personality': 'culture',
  'retinoids-retinol-vs-retinal': 'health',
  'salvia-divinorum-mechanism-of-action': 'health',
  'understanding-audio-compression-and-quality': 'technology',
  'vitamin-c-supplementation-functions-benefits-risks': 'health',
  'vitamin-d-supplementation-research-overview': 'health'
});

function topicForSlug(slug) {
  const key = TOPIC_BY_SLUG[slug] || 'other';
  return { key, label: TOPIC_LABELS[key] };
}

module.exports = {
  TOPIC_LABELS,
  topicForSlug
};
