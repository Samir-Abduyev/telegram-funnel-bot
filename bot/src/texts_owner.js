// Messages to the owner (Russian). HTML.
import { esc, who } from './util.js';

const DOWN_AFTER_MS = 3 * 60 * 1000; // heartbeat is written every minute: 3 min of silence = the bot was down
// /stats «🎥 Задания»: rows { lesson, kind, detail, people, times } from store.taskStats.
const WRONG = { text: 'текст', link: 'ссылку', photo: 'фото/скриншот', file: 'файл', video_file: 'видео файлом', voice: 'голосовое', sticker: 'стикер', gif: 'GIF', audio: 'аудио', other: 'другое' };
const TASKS = (rows) => {
  if (!rows.length) return [];
  const lessons = [...new Set(rows.map((r) => r.lesson))].sort((a, b) => a - b);
  const out = ['', '<b>🎥 Задания</b> (люди; с 19.11)'];
  for (const n of lessons) {
    const of = (kind) => rows.filter((r) => r.lesson === n && r.kind === kind);
    const people = (kind) => of(kind).reduce((a, r) => a + r.people, 0);
    const wrong = of('task_wrong').map((r) => `${WRONG[r.detail] ?? r.detail} ${r.people}`).join(', ');
    out.push(`Урок ${n}: прислали задание ${people('task_done')} · пропустили ${people('task_skip')}` +
      (wrong ? ` · вместо видео прислали: ${wrong}` : ''));
  }
  return out;
};
// Broadcast segment in words: '2' → «сейчас на уроке 2», offer → «дошли до оплаты, но не оплатили» …
const SEG = (seg) => (/^\d$/.test(seg) ? `сейчас на уроке ${seg}`
  : { offer: 'дошли до оплаты, но не оплатили', paid: 'оплатили', all: 'все', lessons: 'ещё на уроках' }[seg] ?? seg);

const SLOT_NAME = (slot) => (slot === 'welcome' ? 'приветствие' : slot === 'offer' ? 'предложение об оплате' : `урок ${slot}`);
const KIND = {
  text: 'текст', video: 'видео', photo: 'фото', document: 'файл', animation: 'GIF',
  video_note: 'кружок', voice: 'голосовое', audio: 'аудио',
};

export const RU = {
  slotName: SLOT_NAME,
  help:
    '<b>Управление воронкой</b>\n\n' +
    '/set 1 — задать урок 1: после команды пришлите видео с подписью (или текст). Так же /set 2 … /set 9\n' +
    '/set welcome — приветствие перед первым уроком\n' +
    '/task 2 — урок 2 требует видео-задание (повторно — выключить)\n' +
    '/swap 2 3 — поменять уроки местами (на пустое место урок просто переедет)\n' +
    '/show 2 — посмотреть урок как ученик (также /show welcome)\n' +
    '/lessons — что заполнено\n' +
    '/stats — сколько людей на каждом шаге\n' +
    '/broadcast — рассылка (голосовое, кружок, видео, текст): кнопками выберите, кому — тем, кто сейчас на уроке 1, 2, 3…, дошёл до оплаты, оплатил или всем\n' +
    '/reset — сбросить ВАШ прогресс, чтобы пройти воронку заново как ученик\n' +
    '/cancel — отменить /set или /broadcast\n\n' +
    '💳 Кнопки оплаты (онлайн / карта / «Ödədim») бот сам ставит под ПОСЛЕДНИМ уроком — призыв к оплате пишите в подписи к нему. ' +
    'Вход: приветствие с одной кнопкой «▶️ Pulsuz dərslərə başla». С урока 2 под уроком есть «📚 Dərslər» (только пройденные уроки). ' +
    '«💬 Adminlə əlaqə» (ваш TG) — только под последним уроком.\n\n' +
    'Чеки приходят сюда с кнопками «Подтвердить / Отклонить». Видео-задания и вопросы учеников (кнопка «❓ Sual ver» под каждым уроком) тоже приходят сюда.\n' +
    '💬 Чтобы ответить ученику, нажмите «Ответить» на его вопросе, задании или чеке и напишите ответ: бот перешлёт его ученику.',
  menu: [
    { command: 'help', description: 'Все команды и как отвечать ученикам' },
    { command: 'lessons', description: 'Что заполнено в воронке' },
    { command: 'set', description: 'Задать урок: /set 1 … /set 9 или /set welcome' },
    { command: 'task', description: 'Урок с видео-заданием: /task 2' },
    { command: 'swap', description: 'Поменять уроки местами: /swap 2 3' },
    { command: 'show', description: 'Посмотреть как ученик: /show 1' },
    { command: 'stats', description: 'Статистика воронки и источников' },
    { command: 'broadcast', description: 'Рассылка (голосовое/текст) по шагам: урок 1, 2, 3…, оплата, все' },
    { command: 'cancel', description: 'Отменить /set или /broadcast' },
    { command: 'reset', description: 'Сбросить свой прогресс (тест воронки)' },
    { command: 'start', description: 'Пройти воронку как ученик' },
  ],
  swapUsage: 'Формат: /swap 2 3 — поменять уроки 2 и 3 местами (если урока 3 нет, урок 2 переедет на место 3)',
  swapNothing: (a, b) => `Уроков ${a} и ${b} нет — нечего менять.`,
  swapped: (a, b) => `✅ Готово: уроки ${a} и ${b} поменялись местами (вместе с заданием).`,
  setUsage: 'Формат: /set 1 … /set 9 или /set welcome',
  waiting: (slot) => `Жду ${SLOT_NAME(slot)}: пришлите одно сообщение — видео с подписью, фото, файл или текст. /cancel — отмена.`,
  saved: (slot, kind) => `✅ Сохранено: ${SLOT_NAME(slot)} (${KIND[kind] ?? kind}). Проверить: /show ${slot}`,
  unsupported: 'Такой тип сообщения не подходит. Пришлите видео, фото, файл, GIF, кружок, аудио или текст.',
  captionTooLong: (n) => `Подпись слишком длинная: ${n} символов, а бот может отправить ученикам максимум 1024. Сократите подпись и пришлите ещё раз (или /cancel). Ничего не сохранено.`,
  cancelled: 'Отменено.',
  taskUsage: 'Формат: /task 2 (номер урока)',
  taskNoLesson: (n) => `Урок ${n} ещё не задан: сначала /set ${n}`,
  taskState: (n, on) => (on
    ? `✅ Урок ${n} теперь с заданием: следующий урок откроется после видео от ученика.`
    : `Урок ${n} теперь без задания: следующий урок по кнопке «Dərsi bitirdim».`),
  showUsage: 'Формат: /show 1 или /show welcome',
  notSet: (slot) => `${SLOT_NAME(slot)} не задан(о). /set ${slot}`,
  defaultShown: (slot) => `☝️ Это стандартный текст (${SLOT_NAME(slot)}). Свой: /set ${slot}`,
  lessons: (content, total, warnings) => {
    const by = Object.fromEntries(content.map((c) => [c.slot, c]));
    const line = (slot) => {
      const c = by[slot];
      return `• ${SLOT_NAME(slot)}: ${c ? KIND[c.kind] ?? c.kind : 'стандартный текст'}${c?.has_task ? ' + задание 🎥' : ''}`;
    };
    const nums = content.map((c) => c.slot).filter((s) => /^\d$/.test(s)).sort();
    const lessonLines = nums.map((s) => {
      const c = by[s];
      const gap = Number(s) > total ? ' ⚠️ не будет показан: пропущен предыдущий урок' : '';
      return `• урок ${s}: ${KIND[c.kind] ?? c.kind}${c.has_task ? ' + задание 🎥' : ''}${gap}`;
    });
    return [
      `<b>Воронка: ${total} урок(ов)</b>`,
      line('welcome'),
      ...(lessonLines.length ? lessonLines : ['• уроков нет: /set 1']),
      ...(total ? [`💳 Кнопки оплаты стоят под уроком ${total} (последним)`] : []),
      ...(warnings.length ? ['', ...warnings.map((w) => `⚠️ ${esc(w)}`)] : []),
    ].join('\n');
  },
  stats: (s, g = { configured: false, n: null, min: 10 }) => [
    '<b>📊 Воронка</b>',
    !g.configured ? '👥 Платная группа: не подключена (GROUP_ID в .env)'
      : g.n === null ? '👥 Платная группа: не удалось посчитать (бот — админ группы?)'
        : `👥 В платной группе сейчас: <b>${g.n}</b> участников (вместе с админами и ботами)` +
          (g.n >= g.min ? ' — ученики видят это число под оплатой' : ` — ученикам покажется от ${g.min}`),
    '',
    `Всего запустили бота: <b>${s.total}</b> (за 7 дней: ${s.week})`,
    ...s.lessons.map((l) => `На уроке ${l.lesson}: ${l.n}`),
    `Дошли до оплаты: ${s.offer}`,
    `Нажали «Ödədim», чек ещё не прислали: ${s.receipt}`,
    `Чек ждёт вашего решения: ${s.review}`,
    `Оплатили: <b>${s.paid}</b>`,
    `Заблокировали бота: ${s.blocked}`,
    ...(s.sources?.length ? [
      '',
      '<b>Откуда пришли</b> (пришло → прошли уроки → оплатили)',
      ...s.sources.map((x) => `${x.source ? esc(x.source) : 'без метки'}: ${x.n} → ${x.finished} → ${x.paid}`),
    ] : []),
    ...TASKS(s.tasks ?? []),
  ].join('\n'),
  reset: 'Ваш прогресс сброшен. Нажмите /start, чтобы пройти воронку как ученик.',

  /** Start report. h = { heartbeat: {at}, stop: {at, reason} } from the previous run. */
  startup: (h, now = new Date()) => {
    const t = (iso) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Baku', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    const mins = (iso) => Math.max(1, Math.round((now - new Date(iso)) / 60000));
    const beat = h.heartbeat?.at;
    if (!beat) return '✅ Бот запущен.';
    const stop = h.stop?.at && new Date(h.stop.at) >= new Date(beat) ? h.stop : null;
    if (stop) {
      return `✅ Бот снова работает. Был остановлен в ${t(stop.at)} (${esc(stop.reason)}), простой ≈${mins(stop.at)} мин.`;
    }
    if (now - new Date(beat) < DOWN_AFTER_MS) return '✅ Бот перезапущен.';
    return `⚠️ <b>Бот снова работает, но был недоступен</b> примерно с ${t(beat)} до ${t(now.toISOString())} (≈${mins(beat)} мин).\n` +
      'Он остановился без предупреждения: выключение или сон компьютера, нехватка памяти, сбой процесса или пропал интернет.\n' +
      'Нажатия учеников за это время Telegram сохранил — бот обрабатывает их сейчас.';
  },

  question: (u, where) => `❓ Вопрос от ${who(u)} (${where})\n💬 Ответить ученику: «Ответить» на вопрос ниже.`,
  task: (u, n) =>`🎥 Задание к уроку ${n} от ${who(u)}\n💬 Ответить ученику: «Ответить» на видео ниже.`,
  replySent: '✅ Ответ отправлен ученику.',
  replyBlocked: '⚠️ Не доставлено: ученик заблокировал бота.',
  receiptReminder: (u, id) => `⏰ Чек №${id} от ${who(u)} ждёт вашего решения больше 2 часов. Кнопки — в сообщении с чеком.`,

  bcUsage: 'Отправьте /broadcast и выберите кнопку, кому писать (или /broadcast 2 — тем, кто сейчас на уроке 2).',
  bcPick: '📣 <b>Рассылка.</b> Кому отправить? Число — сколько человек сейчас на этом шаге (дошли до него и дальше не пошли).',
  bcLessonBtn: (n, count) => `Урок ${n} · ${count}`,
  bcOfferBtn: (count) => `💳 Оплата · ${count}`,
  bcPaidBtn: (count) => `✅ Оплатили · ${count}`,
  bcAllBtn: (count) => `👥 Все · ${count}`,
  bcWaiting: (seg, n) => `Рассылка «${SEG(seg)}»: получателей ${n}.\nПришлите ОДНО сообщение — голосовое, кружок, видео, текст или фото. Его получат все ${n} (от имени бота). /cancel — отмена.`,
  bcEmpty: (seg) => `«${SEG(seg)}» — сейчас никого нет.`,
  bcPreview: (seg, n) => `☝️ Так увидят сообщение. Отправить ${n} получателям («${SEG(seg)}»)?`,
  bcGo: '✅ Отправить',
  bcNo: '❌ Отмена',
  bcStarted: (n) => `📤 Рассылка запущена: ${n} получателей. Пришлю итог.`,
  bcDone: (sent, blocked, failed) => `📤 Рассылка завершена: доставлено ${sent}, заблокировали бота ${blocked}, ошибок ${failed}.`,
  bcGone: 'Эта рассылка уже отправлена или отменена.',
  receipt: (u, id) => `🧾 Чек №${id} от ${who(u)}\nПроверьте оплату и решите (или «Ответить», чтобы написать ученику):`,
  approveBtn: '✅ Подтвердить',
  rejectBtn: '❌ Отклонить',
  approvedMark: '✅ Подтверждено',
  rejectedMark: '❌ Отклонено',
  alreadyDecided: 'Этот чек уже обработан',
  approvedDone: (u) => `✅ ${who(u)}: оплата подтверждена, ссылка в группу отправлена.`,
  rejectedDone: (u) => `❌ ${who(u)}: чек отклонён, ученику предложено прислать чек заново.`,
  noGroup: '⚠️ GROUP_ID не задан в .env: не могу выдать ссылку в группу. Чек остался ждать решения.',
  linkFailed: (e) => `⚠️ Не удалось создать ссылку в группу: ${esc(e)}\nПроверьте, что бот — админ группы с правом «Приглашать пользователей». Чек остался ждать решения.`,
  joined: (u) => `👥 ${who(u)} вступил(а) в группу.`,
  addedToChat: (title, id, admin) =>
    `Бот добавлен в «${esc(title)}».\nID этого чата: <code>${id}</code>\n` +
    (admin ? 'Если это группа для учеников, впишите в .env: GROUP_ID=' + id + ' и перезапустите бота.'
      : '⚠️ Бот не админ: сделайте его админом с правом «Приглашать пользователей».'),
};
