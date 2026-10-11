/** One encoding policy shared by analysis and score repair for cn2en. */
export const CN2EN_TRANSFER_RULES = `
【汉译英：先定骨架，再补显性逻辑】
内部按五步检查，不把内部推理全文输出：①找每句的核心动作与真正主句；②为背景（随着/经过/为了……）选择 with/as/分词/从句等从属手段；③判断中文未写出的逻辑关系（因果、条件、转折、目的）是否需要显性化；④为无主句、动词链、长定语选择英语结构；⑤按英语习惯核对冠词、单复数、时态、搭配与句尾焦点。
1. 中文背景→事件→结果可用英语从句、短语、分词或并列组织；with/as与完整主句都可能成立，不要求唯一骨架。有完整主谓和清楚关系时，不能因背景仍作主句而扣分。“这本书介绍中国历史”用This book introduces/covers Chinese history成立。
2. 没有明说因果时，不把先后、伴随、关联升级成因果。“他努力学习，最后考上大学”用He studied hard and was eventually admitted to university忠实；because/so/Hard work enabled him...强化因果，只有上下文支持时才作有条件对照。“他走进办公室，打开电脑，开始工作”并列walked into the office, turned on the computer and started working即可，不另加开门、坐下等动作。同一层级although/though与but不重复连接同一对分句；不同层级连词可以同句出现，不说“一句只能用一个连接词”。
3. 中文无主句需要语境成立的主语或结构：“经过调查发现”可用An investigation found that...或It was found that...；Through investigation found that...缺主语。after既可作介词也可引导从句，After an investigation found that...是否病句取决于有没有主句；调查可以作found的主语。不能把调查者确定成无依据的政府、国际机构或某类人。“有必要”用It is necessary to do/There is a need to do，不加强成It is imperative。
4. 动词串联可并列、分词或从句；主体、顺序和时间成立时都认可。无连接谓语堆叠是语法错误，引用实际动词链整体修复，避免把一个主干问题拆成多个重复扣分。合法并列主次可另作improve，不扣分。
5. 长定语可用关系从句、后置分词或拆句：“改革开放以来取得的巨大成就”可译the great achievements China has made since reform and opening-up。修饰归属、语法成立即可，不要求复杂句；框架有错时给能直接使用的完整修正。
6. 加强合作、提高效率、促进发展按原文保持cooperation/efficiency/development。仅在上下文明确对象时补出international/work/economic等限定；否则属于无依据增译，不以“具体化”一概认可。可选表达需说明增加的含义及适用条件。Thanks to含因果且常带积极态度，不与所有“随着/伴随”无条件等义。
7. 成语、俗语和文化默认表达必须意译或换成对应习语：走马观花→a cursory glance，逐字硬译（walk horse watch flowers）是错误。举世瞩目→remarkable achievements 等意译成立；achieve achievements 这类同源重复按搭配错误指出。"发挥优势""提高水平"按英语固定搭配核对（give full play to、improve one's level），中式搭配（play advantages）要指出。
8. 冠词、数、主谓一致、时态按完整语境判断。education通常不可数，但an education可指所受教育。泛指students与特指the students取决于原文。“我来这里三年了”若指已在此居住用I have been here for three years；若指反复来访，I have been coming here for three years可以成立。学生没写的come to here不得拿来指责。
9. 信息结构服务重心：句尾焦点调整得当不算偏离原文。"最大的问题是资金不足"译为 The biggest problem is the lack of funding / a shortage of funding 是自然的信息单位，the insufficient funds 这类搭配可作 improve；"其中最重要的"用 among which 重构均成立，只要最重要的信息仍处在焦点位置。
10. 被动、名词化、there be、形式主语it都是合法组织方式，不因形式本身扣分。“我们应该采取措施”可为We should take measures；Measures should be taken是否保留责任主体取决于上下文。effective/urgent/comprehensive不是原文已有词，不默认加入。普通句、常见动词、没有习语不扣流畅度或地道程度。
11. only if不能变成as long as；may/can不能加强成will；关联不能变proved/caused。修正必要条件时核对倒装与情态联动，给完整correctedSentence，不只给局部替换。需要重构的proved→linked ... to不作可执行补丁，要引用完整原句并给完整替代句。
12. 说明引用学生真实片段和中文依据，给最小必要修正，再选2–3个教学点。错误只归一个主维度：事实、范围、条件、情态、逻辑归语境与逻辑；形态/句法归语法；词义/拼写归词汇。一个根因不重复扣分，不同根因即使引文嵌套也分别保留。AI对照、纠错句、说明与学习例句须相互一致，不得增加原文没有的事实。
`;
