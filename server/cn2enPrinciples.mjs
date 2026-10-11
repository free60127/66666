/** One encoding policy shared by analysis and score repair for cn2en. */
export const CN2EN_TRANSFER_RULES = `
【汉译英：先定骨架，再补显性逻辑】
内部按五步检查，不把内部推理全文输出：①找每句的核心动作与真正主句；②为背景（随着/经过/为了……）选择 with/as/分词/从句等从属手段；③判断中文未写出的逻辑关系（因果、条件、转折、目的）是否需要显性化；④为无主句、动词链、长定语选择英语结构；⑤按英语习惯核对冠词、单复数、时态、搭配与句尾焦点。
1. 中文按"背景→事件→结果"推进不等于英语要逐句平铺。先确定哪部分是主句：核心信息作主谓主干，背景（随着科技的发展）降为 with/as 短语或状语从句。合理的重心选择不算错；把背景当主句、主干淹没在流水句里（句子没有中心）必须指出，并说明哪部分才是重点。中文主语直接搬过去是否自然单独判断："这本书介绍了中国历史"用 This book introduces/covers Chinese history 都成立，不强改。
2. 中文没写出的逻辑英语可能要补："他努力学习，最后考上了大学"可译 He studied hard and was eventually admitted to university（and 只表推进），也可用 because/so that 或 Hard work enabled him to... 显化因果——依上下文判断并显化不算增译，两种处理都是合法异译；学生只按先后推进平铺、未体现因果时，宜在 study 或总评中对照因果显化的写法及其语气差别，由学生依语境选择，不判错。但英语同样有简单并列："他走进办公室，打开电脑，开始工作"就应 opened the door, walked in, sat down and began working，硬加 because/therefore 反而是错误。Although/though 与 but 不能同时出现；一个句子只保留一个主连接词。
3. 中文无主句和泛主语必须恢复主语或换结构："经过调查发现"→ The survey shows / An investigation found that / It has been found that；"有必要……"→ It is necessary to do / There is a need to do / More efforts should be made；"人们普遍认为"→ It is generally believed that。介词短语不能作主语（Through investigation found that... 是病句），It is necessary 后接动词原形是语法错误。补出的主语只要符合语境都成立，不算无依据增译。
4. 动词串联必须结构化：并列（opened the door, walked in, sat down, and began working）、分词（Opening the door, he walked in...）、独立主格或从句都成立，动作顺序与主体不错即可，选哪种不算错。无连接的动词堆叠（opened the door entered sat down began）是语法错误；动作全部并列而主次不清时，可作 improve 建议分出层次，不扣分。
5. 中文长定语不能按中文语序硬搬："中国改革开放以来取得的巨大成就"应为 the great achievements (that) China has made since the reform and opening-up 或 achievements made since...；把分词放在 since 短语之后导致谓语误读（achievements since ... achieved prove）是结构错误。定语改从句、后置定语或拆成两句均成立。
6. 抽象词按语境补限定：加强合作/提高效率/促进发展补出对象（cooperation in...、work efficiency、economic development）是合理具体化，不算增译；无对象的空泛排比可作 improve 提示，不扣分。
7. 成语、俗语和文化默认表达必须意译或换成对应习语：走马观花→a cursory glance，逐字硬译（walk horse watch flowers）是错误。举世瞩目→remarkable achievements 等意译成立；achieve achievements 这类同源重复按搭配错误指出。"发挥优势""提高水平"按英语固定搭配核对（give full play to、improve one's level），中式搭配（play advantages）要指出。
8. 冠词、单复数、时态、主谓一致是高频硬伤：中文没有冠词不等于不用判断（education 通常不可数，an education 含义不同）；"学生"泛指用 students，特指用 the students；"我来这里三年了"必须用 have been (here) for three years，瞬间动词（come/go/arrive）与 for 时间段连用是时态错误。"随着"依语境选 with/as/along with/during/thanks to，不必一律 with。
9. 信息结构服务重心：句尾焦点调整得当不算偏离原文。"最大的问题是资金不足"译为 The biggest problem is the lack of funding / a shortage of funding 是自然的信息单位，the insufficient funds 这类搭配可作 improve；"其中最重要的"用 among which 重构均成立，只要最重要的信息仍处在焦点位置。
10. 被动句、名词化、there be、形式主语 it 本身不是错误，是英语的合法组织手段："我们应该采取措施"译 We should take effective measures 或 Measures should be taken 都成立。只有当结构造成歧义、搭配错误或与语域不符时才判 error；AI 对照展示另一种组织方式时用 study，不得宣称学生必须照做。
11. 逻辑连接的强度不可改变：only if 是必要条件，译成 as long as 就改成了充分条件；unless 的否定方向、provided that/in case 的差异分别核对。"只有解决这一问题，项目才能继续"→ Only by solving this problem can the project continue / The project can continue only if this problem is solved；漏掉条件结构写成两个并列句是关系错误。推断与事实、目的与结果不混同。
12. 解释写给学习者：引用学生自己的英文片段，指出错在哪个结构/搭配/形态，给出改正依据和 1-2 个例句或规则；说明中文原意里哪一层关系在英语中如何表达。不要堆"形合/意合/中式英语"等标签，不套一律"加连接词/改被动"的模板；最多选 2-3 个本稿最需要的训练点。AI 润色版的高级表达按 study 讲解，遵守以上各条，不得在改错说明中引入中文原文没有的事实。
`;
