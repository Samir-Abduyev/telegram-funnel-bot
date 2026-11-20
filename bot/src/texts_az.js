// Everything students see (Azerbaijani, «sən»). HTML: only b, i, u, s, a, code.
import { esc } from './util.js';

export const AZ = {
  welcome: (name) =>
    `<b>Salam, ${esc(name || 'dost')}! 👋</b>\n\n` +
    'VibeCeh-in pulsuz video dərslərinə xoş gəlmisən!\n\n' +
    '🎬 Dərsləri ardıcıllıqla izlə.\n' +
    '📚 Əvvəlki dərslərə istədiyin vaxt qayıda bilərsən.\n\n' +
    '<i>Hazırsansa, ilk dərsə başlayaq! 🚀</i>',
  noLessons: 'Dərslər hazırlanır, tezliklə burada olacaq. 🙏',

  // buttons — one meaning everywhere: «📚 Dərslər» = list of passed lessons, «⬅️ Geri» = previous screen
  beginBtn: '▶️ Pulsuz dərslərə başla',
  nextBtn: '➡️ Növbəti dərs',
  menuBtn: '📚 Dərslər',
  contactBtn: '💬 Adminlə əlaqə',
  resumeBtn: '▶️ Davam et',
  backBtn: '⬅️ Geri',
  prevBtn: '⏮ Əvvəlki dərs',
  rewatchBtn: '🎬 Dərslərə yenidən bax',
  askBtn: '❓ Sual ver',
  sendTaskBtn: '📤 Tapşırığı göndər',
  skipBtn: '⏭ Tapşırıqsız davam et',
  // pop-up if «⏭» is pressed before a day has passed (plain text, ≤ 200 characters)
  skipNotYet: 'Əvvəlcə tapşırığı yerinə yetirməyə çalış 🙂 Bu düymə dərsdən bir gün sonra işləyir.',
  // pop-up after «📤 Tapşırığı göndər» (plain text, ≤ 200 characters)
  sendTaskHow: '🎥 Tapşırığı yerinə yetir, nəticəni videoya çək və videonu bu çata göndər. Video gələn kimi növbəti dərs açılacaq.',
  wantJoinBtn: '🚀 Qrupa qoşulmaq istəyirəm',
  payLinkBtn: '💳 Onlayn ödəniş',
  cardBtn: '💬 Kartla ödəniş üçün yaz', // opens the admin's chat — not an in-bot payment
  paidBtn: '✅ Ödədim',
  joinBtn: '👥 Qrupa qoşul',
  channelBtn: '📢 Kanala abunə ol',

  // progress: counted by UNLOCKED lessons (the bot cannot know whether a video was watched)
  progress: (n, total) => `Dərs ${n}/${total}`,
  menuTitle: '📚 <b>Dərslər</b>\n\nKeçdiyin dərsləri buradan yenidən izləyə bilərsən 👇',

  taskHint:
    '🎯 <b>Dərsin tapşırığı</b>\n\n' +
    'Növbəti dərsi açmaq üçün bu dərsdəki tapşırığı yerinə yetir.\n\n' +
    '<b>Nə etməlisən?</b>\n' +
    '1. Tapşırığı tamamla.\n' +
    '2. Nəticəni videoya çək.\n' +
    '3. Videonu bu çata göndər.\n\n' +
    '<i>📩 Videonu göndərdikdən sonra növbəti dərs açılacaq.</i>',
  needVideo: '🎥 Növbəti dərsə keçmək üçün tapşırığın videosunu bura göndər.',
  taskAccepted: '✅ <b>Tapşırığın qəbul edildi!</b>\n\nƏla iş! Növbəti dərs artıq sənin üçün açıqdır. 🚀',
  taskAcceptedLast: '✅ <b>Tapşırığın qəbul edildi!</b>\n\nƏla iş! 🚀', // task on the LAST lesson: nothing more to open
  useButtons: 'Sualın varsa, «❓ Sual ver» düyməsini bas 👇',

  // card payment fallback pop-up (only when OWNER_CONTACT is not a @username; ≤ 200 characters)
  card: (contact) => `Kartla ödəniş üçün adminə yaz: ${contact}\n\nÖdənişdən sonra «✅ Ödədim» düyməsini bas və qəbzi göndər.`,
  askReceipt: '🧾 Ödəniş qəbzini (skrinşot və ya PDF) bura göndər.',
  receiptOnlyMedia: '🧾 Zəhmət olmasa qəbzi şəkil və ya fayl kimi göndər.',
  receiptSent:
    '✅ <b>Ödəniş qəbzin alındı</b>\n\n' +
    'Qəbzin yoxlanış üçün göndərildi.\n\n' +
    '⏳ <b>Status:</b> Yoxlanılır\n\n' +
    'Təsdiqləndikdən sonra qapalı qrupa qoşulmaq üçün sənə link göndərəcəyəm.\n\n' +
    '<i>Nəticə hazır olduqda sənə bildiriş gələcək.</i>',
  underReview: '⏳ <b>Status:</b> Yoxlanılır\n\n<i>Nəticə hazır olduqda sənə bildiriş gələcək.</i>',
  approved:
    '🎉 <b>Ödənişin təsdiqləndi!</b>\n\n' +
    'Qapalı təlim qrupuna qoşulmaq üçün hər şey hazırdır.\n\n' +
    'Aşağıdakı düyməyə bas və qrupa qoşulma sorğusu göndər.',
  rejected: '😔 <b>Ödəniş təsdiqlənmədi</b>\n\nDüzgün qəbzi göndər və ya adminə yaz.',
  joined: '🎉 Qrupa xoş gəldin! Uğurlar!',

  groupCount: (n) => `👥 Bağlı qrupda artıq <b>${n} nəfər</b> öyrənir. Sən də qoşul! 🚀`,
  askPrompt: '✍️ Sualını yaz — mətn, səs və ya video.',
  askSent: '✅ Sualın göndərildi. Cavab burada gələcək.',
  channel: '📢 Faydalı paylaşımlar və tələbələrin nəticələri kanalımızdadır. İstəsən, abunə ol — dərslər isə davam edir 👇',

  // Reminders: [after 1 day, after 3 days] of no progress; they stop as soon as the student moves to the next step
  remind: {
    lesson: [
      '👋 Salam! Dərsin yarımçıq qalıb — bir neçə dəqiqə ayır və davam et 🙂',
      '📚 Pulsuz dərslər hələ də səni gözləyir. Başladığın işi sona çatdır!',
    ],
    task: [
      '🎥 Tapşırığın videosunu hələ göndərməmisən. Çək və bura göndər — növbəti dərs dərhal açılacaq.',
      '💪 Tapşırıq çətin gəlir? Sadədən başla: qısa video da olar. Videonu bura göndər 🙂',
    ],
    offer: [
      '🔥 Bütün pulsuz dərsləri keçdin! Qrupa qoşulmaq üçün son dərsin altındakı «🚀 Qrupa qoşulmaq istəyirəm» düyməsini bas.',
      '⏳ Qrupa qoşulmaq üçün hələ gec deyil. Sualın varsa, adminə yaz — kömək edəcək.',
    ],
    receipt: [
      '🧾 Qəbzi hələ göndərməmisən. Ödəniş etdinsə, qəbzin skrinşotunu bura göndər.',
      '🧾 Qəbzi göndərməyi unutma — onsuz qrupa əlavə edə bilmirəm. Sualın varsa, adminə yaz.',
    ],
  },
};
