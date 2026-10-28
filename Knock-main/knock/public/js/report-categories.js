// The report presets. One list, shared by the server (to validate what arrives) and the browser (to draw the dialog),
// so the two can never disagree. Pure data: no DOM, no Node APIs.
//
//   id        stored in the database, so keep it stable (change `label` freely, never `id`)
//   reasons   optional second level. Without it the person goes straight to the details step
//   note      shown on the details step (for the serious categories)
//   details   'required' makes the details box mandatory (used by "Something else")

const EMERGENCY = 'If someone is in immediate danger, contact your local emergency services right away. A report is not an emergency response.';

export const REPORT_CATEGORIES = [
  {
    id: 'under18',
    label: 'Problem involving someone under 18',
    note: EMERGENCY,
    reasons: [
      { id: 'sexual_content_minor', label: 'Nudity or sexual content involving a minor' },
      { id: 'grooming', label: 'Someone is trying to groom or contact a minor' },
      { id: 'underage_account', label: 'This account may belong to a child' },
      { id: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'harassment',
    label: 'Bullying, harassment or abuse',
    reasons: [
      { id: 'bullying', label: 'Bullying or insults' },
      { id: 'unwanted_contact', label: 'Keeps contacting me after I asked them to stop' },
      { id: 'threats', label: 'Threatening me or someone else' },
      { id: 'sexual_harassment', label: 'Unwanted sexual messages or behavior' },
      { id: 'private_info', label: 'Sharing private information without consent' },
      { id: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'self_harm',
    label: 'Suicide or self-harm',
    note: EMERGENCY,
    reasons: [
      { id: 'suicide_threat', label: 'Talking about suicide' },
      { id: 'self_injury', label: 'Self-injury' },
      { id: 'eating_disorder', label: 'Eating disorder content' },
      { id: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'violent_hateful',
    label: 'Violent, hateful or disturbing content',
    reasons: [
      { id: 'graphic_violence', label: 'Graphic violence or gore' },
      { id: 'hate_speech', label: 'Hate speech or symbols' },
      { id: 'violent_threats', label: 'Calls for or threats of violence' },
      { id: 'extremism', label: 'Violent extremism or dangerous groups' },
      { id: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'restricted_items',
    label: 'Selling or promoting restricted items',
    reasons: [
      { id: 'drugs', label: 'Drugs' },
      { id: 'weapons', label: 'Weapons' },
      { id: 'counterfeit', label: 'Counterfeit goods' },
      { id: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'adult_content',
    label: 'Adult content',
    reasons: [
      { id: 'nudity', label: 'Nudity or sexual activity' },
      { id: 'sexual_solicitation', label: 'Sexual solicitation' },
      { id: 'unwanted_explicit', label: 'Sent me explicit content I didn’t ask for' },
      { id: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'scam_fraud',
    label: 'Scam, fraud or false information',
    reasons: [
      { id: 'asks_for_money', label: 'Asking for money or gift cards' },
      { id: 'phishing', label: 'Phishing or suspicious links' },
      { id: 'impersonation_scam', label: 'Pretending to be someone to trick people' },
      { id: 'false_info', label: 'Spreading false information' },
      { id: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'fake_profile',
    label: 'Fake profile',
    reasons: [
      { id: 'pretending_me', label: 'Pretending to be me' },
      { id: 'pretending_other', label: 'Pretending to be someone else' },
      { id: 'bot_spam', label: 'A bot or spam account' },
      { id: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'intellectual_property',
    label: 'Intellectual property',
    reasons: [
      { id: 'copyright', label: 'Copyright' },
      { id: 'trademark', label: 'Trademark' },
      { id: 'other', label: 'Something else' },
    ],
  },
  { id: 'other', label: 'Something else', details: 'required' },
];

export const findCategory = (id) => REPORT_CATEGORIES.find((c) => c.id === id) ?? null;

// Returns the category and reason when the pair is allowed, otherwise null. Used by the server.
export function validateReport(categoryId, reasonId) {
  const category = findCategory(categoryId);
  if (!category) return null;
  if (!category.reasons) return reasonId ? null : { category, reason: null };
  const reason = category.reasons.find((r) => r.id === reasonId);
  return reason ? { category, reason } : null;
}
