// 离线演示样本：来自用户提供的 lesson18 作业参考（docx）
// 仅用于没有配置 API Key 时预览界面；真实生成由 /api/analyze 完成。
export const DEMO_LESSON_18 = {
  title: 'Lesson 18 · He often does this!',
  chinese: '我在一家乡村小酒店吃过午饭后，就找我的提包。我曾把它放在门边的椅子上，可这会儿不见了！当我正在寻找时，酒店老板走了进来。\n“您吃得好吗？”他问。\n“很好，谢谢。”我回答，“但我付不了帐，我的提包没有了。”\n酒店老板笑了笑，马上走了出去。一会儿工夫他拿着我的提包回来了，把它还给了我。\n“实在抱歉，”他说，“我的狗把它弄到花园里去了，他常干这种事！”',
  draft: 'I was searching my bag after having lunch at a little village bar. I had put it on the chair beside the door. Nevertheless, I couldn’t find it! Just I was searching when the bar’s boss came over.\n“Do you have lunch well?” he asked.\n“Fine, thanks.” I replied,“but I can’t pay the bill, my bag is lost.”\nThe boss smiled, walked out quickly, and took my bag back in a while, then he returned it to me.\n“I’m so sorry,” he said.“My dog took it to the garden, and he is always doing it!”',
  ai: 'After having lunch at a small village bar, I started looking for my bag. I had left it on a chair by the door, but now it was gone. Just as I was searching, the owner of the bar came over.\n“Did you enjoy your meal?” he asked.\n“Yes, thank you,” I replied, “but I can’t pay the bill—my bag is missing.”\nThe owner smiled, went out quickly, and returned shortly with my bag, which he handed back to me.\n“I’m very sorry,” he said. “My dog took it out to the garden. He often does this!”',
  original: 'After I had had lunch at a village pub, I looked for my bag. I had left it on a chair beside the door and now it wasn’t there! As I was looking for it, the landlord came in.\n‘Did you have a good meal?’ he asked.\n‘Yes, thank you,’ I answered, ‘but I can’t pay the bill. I haven’t got my bag.’\nThe landlord smiled and immediately went out. In a few minutes he returned with my bag and gave it back to me.\n‘I’m very sorry,’ he said. ‘My dog had taken it into the garden. He often does this!’',
  overall: {
    score: 78,
    scoreBreakdown: [
      { label: '词汇准确', score: 15, max: 20, comment: 'search my bag 搭配错误，应掌握 search for / look for' },
      { label: '语法与时态', score: 16, max: 20, comment: '过去时逐步稳定，但直接引语时态一致性还需注意' },
      { label: '语境与逻辑', score: 16, max: 20, comment: '情节基本忠实，bar/boss 选词与原文 pub/landlord 有偏差' },
      { label: '流畅度', score: 16, max: 20, comment: '句子完整连贯，个别句子衔接可更自然' },
      { label: '地道程度', score: 15, max: 20, comment: '口语化问句与动词搭配距离母语者还有距离' },
    ],
    issues: 12,
    summary: '整体能基本传达故事大意，但动词用法（search）、时态切换（过去时 vs 现在时）、口语表达（Do you have lunch well?）和名词选择（bar/boss）存在多处不地道的地方。'
      + ' 亮点是句式完整、标点基本规范；最值得改进的是“寻物”类动词搭配和直接引语的时态一致性。',
    highlights: ['时态基本稳定在一般过去时，叙事顺序清楚', '句子结构完整，没有断句', '用 won’t/can’t 等缩写自然'],
    advice: ['复习 search for / look for 的搭配', '练习 Did you enjoy...? 与 have a good... 的用法', '注意直接引语中的 Mr./boss/owner 称谓地道性'],
  },
  sentences: [
    {
      cn: '我在一家乡村小酒店吃过午饭后，就找我的提包。',
      draft: 'I was searching my bag after having lunch at a little village bar.',
      ai: 'After having lunch at a small village bar, I started looking for my bag.',
      original: 'After I had had lunch at a village pub, I looked for my bag.',
      findings: [
        { category: '词义', from: 'search my bag', to: 'search for my bag', level: 'error',
          explanation: 'search + 地点 + for + 目标；search my bag 意为“搜查包内”，与“寻找”不符。',
          dimensions: ['固定搭配', '语域', '语义轻重'],
          synonyms: [
            { word: 'search for', meaning: '寻找（某物/某人）', register: '通用', tone: '中性', strength: '中', usage: '宾语是寻找的目标：search for my bag', example: 'I searched for my keys in every pocket.' },
            { word: 'look for', meaning: '寻找', register: '日常口语', tone: '中性', strength: '弱', usage: '最日常的说法', example: 'I am looking for my bag.' },
          ],
          examples: [
            { en: 'I was searching for my bag after lunch.', cn: '午饭后我在找我的包。' },
            { en: 'The police searched the house for the missing ring.', cn: '警察搜查房子寻找丢失的戒指。' },
          ] },
        { category: '词义', from: 'a little village bar', to: 'a village pub / a small village bar', level: 'improve',
          explanation: 'pub 是英式“提供餐食的小酒馆”，比 bar 更贴合课文语境；small 比 little 更中性。',
          dimensions: ['语域', '感情色彩'],
          synonyms: [
            { word: 'pub', meaning: '（英式）酒馆、小馆', register: '英式/日常书面', tone: '中性', strength: '中', usage: '可提供餐食的小酒馆，课文语境', example: 'We had lunch at a village pub.' },
            { word: 'bar', meaning: '酒吧、吧台', register: '美式/通用', tone: '中性', strength: '弱', usage: '侧重卖酒的吧台或酒吧', example: 'They met at a bar downtown.' },
            { word: 'inn', meaning: '小客栈、乡村旅店', register: '正式/书面', tone: '中性偏雅', strength: '中', usage: '既可住宿也可用餐的乡村小店', example: 'They stayed at a country inn.' },
          ] },
        { category: '地道程度', from: 'started looking for my bag', to: 'After having lunch..., I started...', level: 'study', explanation: '介词短语开头表示时间先后，比逐字直译更地道。' },
        { category: '语法', from: 'After I had had lunch', to: 'After I had had lunch（过去完成时）', level: 'study', explanation: 'had had 强调“吃午饭”发生在“找包”之前；比一般过去时更严谨。' },
      ],
    },
    {
      cn: '我曾把它放在门边的椅子上，可这会儿不见了！当我正在寻找时，酒店老板走了进来。',
      draft: 'I had put it on the chair beside the door. Nevertheless, I couldn’t find it! Just I was searching when the bar’s boss came over.',
      ai: 'I had left it on a chair by the door, but now it was gone. Just as I was searching, the owner of the bar came over.',
      original: 'I had left it on a chair beside the door and now it wasn’t there! As I was looking for it, the landlord came in.',
      findings: [
        { category: '语法', from: 'Just I was searching', to: 'Just as I was searching / I was just searching', level: 'error', explanation: '语序错误；Just as... 引导时间状语，或用 I was just searching。' },
        { category: '词义', from: 'put it on the chair', to: 'left it on a chair', level: 'improve', explanation: 'leave 强调“放置后遗留在此”，更符合“包还在原处但不见了”。' },
        { category: '词义', from: 'the bar’s boss', to: 'the owner / landlord', level: 'improve', explanation: 'landlord 专指酒馆老板；bar 的 boss 口语且不地道。' },
        { category: '地道程度', from: 'it was gone', to: 'it was gone / wasn’t there', level: 'study', explanation: 'it was gone 是表达“不见了”最自然的说法。' },
      ],
    },
    {
      cn: '“您吃得好吗？”他问。“很好，谢谢。”我回答，“但我付不了帐，我的提包没有了。”',
      draft: '“Do you have lunch well?” he asked.“Fine, thanks.” I replied,“but I can’t pay the bill, my bag is lost.”',
      ai: '“Did you enjoy your meal?” he asked.“Yes, thank you,” I replied, “but I can’t pay the bill—my bag is missing.”',
      original: '‘Did you have a good meal?’ he asked.‘Yes, thank you,’ I answered, ‘but I can’t pay the bill. I haven’t got my bag.’',
      findings: [
        { category: '搭配', from: 'Do you have lunch well?', to: 'Did you enjoy your meal? / Did you have a good meal?', level: 'error', explanation: '询问用餐体验用 enjoy one’s meal 或 have a good meal；well 不能修饰 have。' },
        { category: '语域', from: 'Fine, thanks.', to: 'Yes, thank you.', level: 'improve', explanation: 'Fine 回应 How are you 更合适；评价餐食应更正式体面。' },
        { category: '标点', from: 'I replied,“but...', to: 'I replied, “but ...”', level: 'error', explanation: '直接引语逗号后应留空格并正确闭合引号。' },
        { category: '词义', from: 'my bag is lost', to: 'my bag is missing / I haven’t got my bag', level: 'improve', explanation: 'lost 暗示永久丢失；missing 更贴合“暂时不见了”。' },
      ],
    },
    {
      cn: '酒店老板笑了笑，马上走了出去。一会儿工夫他拿着我的提包回来了，把它还给了我。',
      draft: 'The boss smiled, walked out quickly, and took my bag back in a while, then he returned it to me.',
      ai: 'The owner smiled, went out quickly, and returned shortly with my bag, which he handed back to me.',
      original: 'The landlord smiled and immediately went out. In a few minutes he returned with my bag and gave it back to me.',
      findings: [
        { category: '流畅度', from: 'smiled, walked..., and took..., then he returned...', to: 'smiled, went out..., and returned shortly with...', level: 'error', explanation: '平行结构被 then... 打断，动作堆叠冗长；应保持三个动词短语并列。' },
        { category: '词义', from: 'in a while', to: 'shortly / in a few minutes', level: 'improve', explanation: 'in a while 可能表示“一段时间后”，不如 shortly 精确表达“很快”。' },
        { category: '句式', from: 'returned it to me', to: 'which he handed back to me', level: 'study', explanation: '定语从句把“回来”和“递还”融合，简洁地道。' },
      ],
    },
    {
      cn: '“实在抱歉，”他说，“我的狗把它弄到花园里去了，他常干这种事！”',
      draft: '“I’m so sorry,” he said.“My dog took it to the garden, and he is always doing it!”',
      ai: '“I’m very sorry,” he said. “My dog took it out to the garden. He often does this!”',
      original: '‘I’m very sorry,’ he said. ‘My dog had taken it into the garden. He often does this!’',
      findings: [
        { category: '语法', from: 'he is always doing it', to: 'He often does this!', level: 'improve', explanation: 'always + 进行时可表埋怨，但 it 指代不明；一般现在时更清晰中性。' },
        { category: '介词', from: 'took it to the garden', to: 'took it out to / into the garden', level: 'improve', explanation: 'out to 强调“从屋外拿到花园”，更符合故事动作方向。' },
        { category: '语域', from: 'I’m so sorry', to: 'I’m very sorry', level: 'improve', explanation: 'very 比 so 更正式克制，符合店主道歉语气。' },
      ],
    },
  ],
  vocabularyNotes: [
    {
      word: 'search / look for / seek',
      type: '动词 · 搭配',
      meaning: '三者都有“寻找”义，但搭配、语域与强弱不同。',
      dimensions: ['固定搭配', '语域', '语义轻重'],
      synonyms: [
        { word: 'search', meaning: '搜查；仔细寻找', register: '正式/中性', tone: '中性', strength: '中', usage: 'search + 地点 + for + 目标；search my bag 是“搜查包里”，不是“找包”', example: 'The police searched the house for clues.' },
        { word: 'look for', meaning: '寻找', register: '日常口语', tone: '中性', strength: '弱', usage: '最通用的“找”', example: 'I looked for my bag everywhere.' },
        { word: 'seek', meaning: '寻求；寻找', register: '书面/正式', tone: '中性', strength: '中强', usage: '常用于抽象目标（seek help / seek approval）', example: 'They sought shelter from the rain.' },
      ],
      examples: [
        { en: 'I was searching for my bag.', cn: '我正在找我的包。' },
        { en: 'I looked everywhere for my bag.', cn: '我到处找我的包。' },
      ],
      note: '固定搭配：宾语是包/人/线索时用 search for；宾语是房间/口袋等地点时用 search（搜查）。',
    },
    {
      word: 'get on / off vs get in / out of',
      type: '动词短语 · 交通工具搭配',
      meaning: '根据交通工具内部空间决定用 on/off 还是 in/out of。',
      dimensions: ['固定搭配', '语用'],
      synonyms: [
        { word: 'get on / get off', meaning: '上/下（大交通工具）', register: '通用', tone: '中性', strength: '—', usage: '公交、火车、轮船、飞机等可以站立走动的大交通工具', example: 'We got on the bus at the corner.' },
        { word: 'get in / get out of', meaning: '上/下（小空间交通工具）', register: '通用', tone: '中性', strength: '—', usage: '小轿车、出租车、独木舟等无法在里面随意走动的小空间', example: 'He got out of the taxi.' },
      ],
      examples: [
        { en: 'She got off the bus and walked home.', cn: '她下了公交车走回家。' },
        { en: 'He got out of the car and locked the door.', cn: '他下了车并锁上车门。' },
      ],
      note: '判断标准：能否在里面 move around。能走动→on/off；不能走动→in/out of。',
    },
  ],
  idiomHighlights: [
    { situation: '突然发生', common: 'suddenly', idiom: 'out of the blue', example: 'The phone rang out of the blue.', explanation: '比 suddenly 更有“毫无预兆、从天而降”的画面感，适合描述意外事件，语气更生动。' },
    { situation: '非常生气', common: 'very angry', idiom: 'fuming / seething', example: 'He was fuming at the news.', explanation: 'fuming 像“冒烟”一样强调怒不可遏，比 very angry 更有情绪冲击力。' },
    { situation: '立刻离开/滚开', common: 'get away now', idiom: 'beat it / clear off', example: 'The guards told the boys to beat it.', explanation: 'beat it 是口语化的“快走开”，比 get away now 更符合吆喝语气，适合直接引语。' },
  ],
};

export const DEMO_LESSONS = [
  { lesson: 18, title_en: 'He often does this!', title_cn: '他经常干这种事！' },
  { lesson: 20, title_en: 'One man in a boat', title_cn: '独坐孤舟' },
  { lesson: 22, title_en: 'A glass envelope', title_cn: '玻璃信封' },
];
