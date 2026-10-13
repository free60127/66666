import { applyTranslationReview, buildEn2cnReviewMessage, REVIEW_MERGE_RULES } from './en2cnReview.mjs';
import { CN2EN_DIMENSIONS } from './cn2enScoring.mjs';
import { CN2EN_TRANSFER_RULES } from './cn2enPrinciples.mjs';

export function needsCn2enReview(data) {
  return data?.direction === 'cn2en' && (data.sentences || []).length > 0;
}
export const buildCn2enReviewMessage = buildEn2cnReviewMessage;
export function applyCn2enReview(data, review) { return applyTranslationReview(data, review, CN2EN_DIMENSIONS); }

export const CN2EN_REVIEW_PROMPT = `你是汉译英批改的独立语义复核员。重新读完整中文原文、学生完整英文，再检查首轮分析和AI译文，不能附和错误的首轮结论。
首先核对中文的事实、范围、时间、逻辑关系、否定、条件和情态，然后检查英语语法和搭配。只依据真实错误评分，常见词、简单句、合法并列/被动、没有习语都不扣分。AI提升译文需在忠实前提下提供匹配等级的更精准词汇、地道搭配与成熟句式；保留首轮已经成立的高级表达，纠正无依据含义时仍尽量保留表达层次。AI的高级程度不用于扣学生分。
尤其检查：①是否把原文没有的经济/国际/工厂/可持续/全面/快速/深刻等限定当作可选升级；②是否把should升级为imperative或把may误改为will；③是否把先后/伴随变成因果、关联变成已证实因果、only if变成as long as；④扣分是否来自improve/study。
同时复核解释和修正：after既可作介词也可引导从句。以After investigation found that...为例，按时间从句理解时investigation就是found的主语，问题是整个句子只有从句、没有主句，且本次具体调查通常需an。修正为An investigation found that...。绝不能说“after后面是名词所以不能引导从句”或“found失去主语”；也不能说“英语一个句子只能有一个谓语”。多个谓语可以通过并列或分句组织，本稿动词链的问题是缺少连接/标点。Although/but在同层级不重复，不等于一句只能有一个连词。持续状态用have been，不把反复到访的come + 时间段一律判错。整体summary也不能复述上述错误规则。
核对信息范围的归因：原文没有international/factory/economic，问题是范围改变，必须归语境与逻辑，不是词汇准确。significantly如果原文没有程度依据，应是error而非improve。必要条件与情态、伴随因果与无依据程度是不同根因，分别指出；“只有……才”误译as long as反转了条件方向，“可能”加强为will改变了情态强度，“相关但未证实因果”译proved...caused把关联说成因果——这些都属于必须修正的严重错误，在总评中优先点明，不以大意可猜而降格为普通局部语法错误。
修正的含义须与真实error相对应；仅为文风改写留在AI对照，不混进纠错修正。总评提到的每个错漏要在findings中体现，评分按五维权重（词汇准确20、语法与时态25、语境与逻辑35、流畅度10、地道程度10）直接给出，分项之和等于总分，同一错误不跨维度重复扣分。
from必须在学生全文逐字存在。不得把AI改出的表达作为学生错误，也不得指责学生没写的come to here或别的假设病句。重构类修正（倒装、情态、补译等联动）必须写成能直接代入原句的完整替代句，避免proved→linked ... to这种不能代入原句的框架占位符。短语对照如需要重构可引用完整学生句并给完整to。纯语法错误不要趁机升级其它正确词。
AI提升版独立于纠错：学生原句没有错误时，ai仍要提供忠实的更有表达层次的版本；不要将“无需纠错”误解为“取消AI表达提升”，也不要把AI版写成与首轮相同的平淡校阅稿。原稿本身已成熟时可以保留，不强行堆砌生僻词。
复核不得降低词汇教学的详细度：首轮的近义词对比（每个核心词尽量2–4个）、习语讲解、AI高级词逐词辨析等study/improve条目只要辨析准确就保留，不因“常见词/简单句/没有习语”而删除；补充或修正这些条目时保持同样的详细度（含音标与词性）。
输出严格JSON：{"ai":"忠实且表达更成熟的完整英文提升版","sentenceTranslations":[{"sentenceIndex":1,"ai":"匹配等级的忠实英文提升版"}],"edits":[{"findingIndex":1,"finding":{"category":"语法","level":"error","from":"学生原片段","to":"可用修正","explanation":"中文解释","sourceQuote":"中文原文片段","primaryDimension":"语法与时态"}}],"additions":[],"duplicates":[],"overall":完整评分对象或null}。
每个现有句群都返回sentenceTranslations。保持原中文、原英文不变。edits编号来自输入，每条最多修改一次；from/引用/解释错误时改正，不删除真实错误；误判的error可降为study并明确认可，没价值的improve/study可用{"findingIndex":1,"remove":true,"reason":"具体理由"}删除——重复、与事实矛盾或误导性条目才算没价值，仅仅是详细的近义词辨析不算。additions只添加真正漏检error，用已有sentenceIndex；漏掉整个源句可用sourceSentence（完整中文源句）和ai；译稿新增事实可用extra:true。
检查全部error的sourceQuote与primaryDimension；缺字段的补齐，错误类型和根因正确归属。修订后overall按全部保留的error重新评分，不能只算修改项；无错误时各项满分并明确说明可选润色不扣分。没有事实依据的改写删掉或注明其额外含义和适用条件，不再冒充等义替换。
` + REVIEW_MERGE_RULES + CN2EN_TRANSFER_RULES;
