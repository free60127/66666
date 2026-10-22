/**
 * 写作题库（写作模式首页的题目列表）。
 *
 * ## 为什么题目全部自编
 * 参考竞品的题库呈现形式（话题/题型/难度筛选 + 题目卡片），但**不收录任何剑桥真题或
 * 考场回忆题**——那些内容有明确版权，而本站是备案运营、要进学校渠道的项目。
 * 这里每一道都是按通用议论题格式（同意反对 / 讨论双方 / 利弊 / 问题解决 / 两问）
 * 原创撰写的题目；题式本身是公共的考试文体，题目内容不来自任何已出版物。
 *
 * 字段：
 * - id：稳定 id（写作页的草稿、历史归属都用它，不要改）
 * - question：英文题干（原样展示、原样发给批改）
 * - topic：话题分类（筛选行）
 * - type：题型（筛选行）
 * - level：难度（初级/中级/高级）
 * - zh：中文短标题（卡片上帮助快速识别题目主题）
 * - hot：高频标记（近年常练的题目，卡片上加圆点，对应竞品的「· 标点的是高频选项」）
 */

export const WRITING_TOPIC_FILTERS = {
  topics: ['教育', '科技', '环境', '社会', '媒体', '工作', '生活', '文化', '健康'],
  types: ['同意反对', '讨论双方', '利弊', '问题解决', '两问'],
  levels: ['初级', '中级', '高级'],
};

export const WRITING_TOPICS = [
  // ---------- 教育 ----------
  {
    id: 'edu-homework', zh: '家庭作业该不该少留', topic: '教育', type: '同意反对', level: '初级',
    question: 'Some people believe that school students should be given less homework so they have more time for rest and hobbies. Do you agree or disagree?',
  },
  {
    id: 'edu-exams', zh: '考试是不是最好的评价方式', topic: '教育', type: '讨论双方', level: '中级', hot: true,
    question: 'Some people think formal examinations are the best way to assess students, while others believe coursework and projects are fairer. Discuss both these views and give your own opinion.',
  },
  {
    id: 'edu-online', zh: '线上课堂能否替代线下课堂', topic: '教育', type: '讨论双方', level: '中级',
    question: 'Online lessons are becoming more common in schools and universities. Some people argue they can replace traditional classrooms, while others disagree. Discuss both views and give your own opinion.',
  },
  {
    id: 'edu-arts', zh: '艺术课要不要让位于主科', topic: '教育', type: '两问', level: '中级',
    question: 'In some schools, art and music lessons are being cut to make more time for science and mathematics. Why is this happening? Do you think it is a positive or negative development?',
  },
  {
    id: 'edu-money', zh: '大学生该学感兴趣的还是好找工作的专业', topic: '教育', type: '讨论双方', level: '高级',
    question: 'Some students choose a university subject that interests them, while others choose one that leads to a well-paid job. Discuss both these views and give your own opinion.',
  },

  // ---------- 科技 ----------
  {
    id: 'tech-phones', zh: '中学生带手机进校园', topic: '科技', type: '同意反对', level: '初级', hot: true,
    question: 'Many secondary school students carry a smartphone with them every day. Some people think phones should be banned in schools. Do you agree or disagree?',
  },
  {
    id: 'tech-ai', zh: 'AI 会夺走还是创造工作', topic: '科技', type: '两问', level: '中级',
    question: 'Artificial intelligence is changing the workplace rapidly. What kinds of jobs are most likely to be affected? Do you think this change will do more good than harm?',
  },
  {
    id: 'tech-social', zh: '社交媒体与人际关系', topic: '科技', type: '利弊', level: '中级',
    question: 'Nowadays people spend more time communicating through social media than meeting face to face. What are the advantages and disadvantages of this trend?',
  },
  {
    id: 'tech-cash', zh: '无现金社会', topic: '科技', type: '利弊', level: '初级',
    question: 'In many countries, people are paying with their phones instead of cash. What are the advantages and disadvantages of a cashless society?',
  },
  {
    id: 'tech-privacy', zh: '便利与隐私的取舍', topic: '科技', type: '讨论双方', level: '高级',
    question: 'Technology companies collect large amounts of personal data to provide better services. Some people accept this trade-off, while others think privacy should come first. Discuss both these views and give your own opinion.',
  },

  // ---------- 环境 ----------
  {
    id: 'env-plastic', zh: '限制一次性塑料', topic: '环境', type: '同意反对', level: '初级',
    question: 'Some people think governments should ban single-use plastics such as bags and straws. Do you agree or disagree?',
  },
  {
    id: 'env-transport', zh: '让市民少开车的办法', topic: '环境', type: '问题解决', level: '中级',
    question: 'Private cars are a major cause of air pollution in many cities. What problems does heavy car use cause? What can governments do to persuade people to drive less?',
  },
  {
    id: 'env-growth', zh: '经济发展与环境保护', topic: '环境', type: '讨论双方', level: '高级', hot: true,
    question: 'Some people argue that economic growth must slow down to protect the environment, while others believe growth and a clean environment can be achieved at the same time. Discuss both these views and give your own opinion.',
  },
  {
    id: 'env-energy', zh: '要不要为清洁能源买单', topic: '环境', type: '同意反对', level: '中级',
    question: 'Switching to clean energy often raises costs for businesses and households in the short term. Some people think the switch should happen as fast as possible. To what extent do you agree?',
  },

  // ---------- 社会 ----------
  {
    id: 'soc-volunteer', zh: '年轻人该不该做志愿服务', topic: '社会', type: '同意反对', level: '初级',
    question: 'Some people believe every young person should spend some time doing volunteer work. Do you agree or disagree?',
  },
  {
    id: 'soc-aging', zh: '老龄化社会的照顾责任', topic: '社会', type: '讨论双方', level: '中级',
    question: 'Who should take main responsibility for caring for elderly people: their families or the government? Discuss both these views and give your own opinion.',
  },
  {
    id: 'soc-city', zh: '大城市生活值不值', topic: '社会', type: '利弊', level: '初级',
    question: 'More and more young people move to big cities for study and work. What are the advantages and disadvantages of living in a big city?',
  },
  {
    id: 'soc-money', zh: '金钱是不是工作最重要的动力', topic: '社会', type: '同意反对', level: '中级',
    question: 'Many factors motivate people at work. Some people think money is the most important one. Do you agree or disagree?',
  },
  {
    id: 'soc-gap', zh: '代际之间为什么越来越难互相理解', topic: '社会', type: '两问', level: '高级',
    question: 'In many countries, young people and older people find it harder to understand each other. What are the reasons for this? What can be done to bring the generations closer?',
  },

  // ---------- 媒体 ----------
  {
    id: 'med-fake', zh: '假新闻为什么传播得快', topic: '媒体', type: '两问', level: '中级', hot: true,
    question: 'False information spreads quickly on the internet. Why do you think this happens? What can be done to solve the problem?',
  },
  {
    id: 'med-celebrity', zh: '明星该不该成为青少年的榜样', topic: '媒体', type: '同意反对', level: '中级',
    question: 'Famous singers, actors and athletes often appear in school textbooks and advertisements. Some people think celebrities make poor role models for teenagers. Do you agree?',
  },
  {
    id: 'med-alone', zh: '一个人看电影还是一起看', topic: '媒体', type: '两问', level: '初级',
    question: 'These days many people prefer to watch films and programmes alone on their phones rather than with family or friends. Why is this the case? Do you think it is a positive or negative trend?',
  },

  // ---------- 工作 ----------
  {
    id: 'work-remote', zh: '远程办公是利是弊', topic: '工作', type: '利弊', level: '中级',
    question: 'Working from home has become normal in many industries. What are the advantages and disadvantages of remote work for both workers and companies?',
  },
  {
    id: 'work-hours', zh: '四天工作制', topic: '工作', type: '同意反对', level: '中级', hot: true,
    question: 'Some companies are moving to a four-day working week with the same pay. Do you think this is a good idea?',
  },
  {
    id: 'work-gapyear', zh: '上大学前该不该先工作一年', topic: '工作', type: '讨论双方', level: '高级',
    question: 'In some countries, young people are encouraged to work or travel for a year between school and university. Some think this is valuable, others think it wastes time. Discuss both views and give your own opinion.',
  },

  // ---------- 生活 ----------
  {
    id: 'life-cook', zh: '年轻人不会做饭怎么办', topic: '生活', type: '问题解决', level: '初级',
    question: 'Many young people today cannot cook basic meals and depend on take-away food. Why is this happening? What can be done to help young people learn to cook?',
  },
  {
    id: 'life-spend', zh: '攒钱还是及时享受', topic: '生活', type: '讨论双方', level: '中级',
    question: 'Some people believe it is better to save money for the future, while others think it is better to spend it enjoying life now. Discuss both these views and give your own opinion.',
  },
  {
    id: 'life-pets', zh: '养宠物越来越流行的原因', topic: '生活', type: '两问', level: '初级',
    question: 'Keeping pets has become very popular among people who live alone in big cities. What are the reasons for this? Do you think the trend is positive or negative?',
  },

  // ---------- 文化 ----------
  {
    id: 'cul-language', zh: '小语种正在消失', topic: '文化', type: '两问', level: '高级',
    question: "Every year, fewer people speak many of the world's minority languages. Why is this happening? Is the loss of languages important, or is it a natural change we should accept?",
  },
  {
    id: 'cul-festival', zh: '传统节日的商业味越来越浓', topic: '文化', type: '同意反对', level: '中级',
    question: 'Traditional festivals are increasingly celebrated with shopping events and commercial promotions. Some people think this damages the true meaning of the festivals. Do you agree?',
  },
  {
    id: 'cul-museum', zh: '博物馆该不该免费开放', topic: '文化', type: '讨论双方', level: '中级',
    question: 'Some people think museums should be free to visit, while others believe visitors should pay an entrance fee. Discuss both these views and give your own opinion.',
  },

  // ---------- 健康 ----------
  {
    id: 'hea-sugar', zh: '给高糖饮料加税', topic: '健康', type: '同意反对', level: '中级', hot: true,
    question: 'Some governments have added a tax to sugary drinks to improve public health. Do you think this is an effective measure?',
  },
  {
    id: 'hea-screen', zh: '孩子的屏幕时间', topic: '健康', type: '问题解决', level: '初级',
    question: 'Children today spend many hours a day looking at screens. What problems does this cause? What can parents and schools do about it?',
  },
  {
    id: 'hea-mental', zh: '心理健康课该不该进校园', topic: '健康', type: '同意反对', level: '高级',
    question: 'Some people think mental health education should be a required subject in schools, while others think this should be handled by families. To what extent do you agree?',
  },
];

/** 按难度给出的「建议词数」，写作页与批改 prompt 共用这份口径 */
export const WRITING_LEVEL_WORDS = {
  初级: 120,
  中级: 180,
  高级: 250,
};
