import React from 'react';
import { GraduationCap, BookOpen, Library, Feather } from 'lucide-react';

/**
 * 首次入门目标选择：只问一次"你的目标"，据此定默认润色难度，
 * 并把用户带到对应级别的第一篇短课文——避免新用户第一眼就是
 * 一篇 150 词的四级真题长文（第一篇写不出来就流失）。
 * 选择存 localStorage（bt-goal），老用户（有历史）不弹。
 */
const GOALS = [
  { key: 'middle', label: '中学', desc: '小初~高中课文，从短句开始', level: '高考英语', section: '小初英语' },
  { key: 'cet', label: '四六级', desc: '大学课文 + 四六级真题', level: '四六级', section: '四六级' },
  { key: 'kaoyan', label: '考研', desc: '考研课文 + 考研真题', level: '考研/专四', section: '考研英语' },
  { key: 'tem8', label: '专八', desc: '专八课文 + 专八真题', level: '专八', section: '专八' },
];

export default function OnboardingGoal({ onPick, onClose }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal goal-modal" role="dialog" aria-modal="true" aria-label="选择你的学习目标" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>你的目标是什么？</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><Feather size={16} /></button></div>
        <p className="goal-lead">选一个，我会把练习难度和课文难度调到匹配；之后随时可在顶栏「难度」里改。</p>
        <div className="goal-grid">
          {GOALS.map((g, i) => (
            <button type="button" key={g.key} className="goal-card" onClick={() => onPick(g)}>
              <span className="goal-icon">{[<GraduationCap size={18} key="a" />, <BookOpen size={18} key="b" />, <Library size={18} key="c" />, <Feather size={18} key="d" />][i]}</span>
              <strong>{g.label}</strong>
              <small>{g.desc}</small>
            </button>
          ))}
        </div>
        <button type="button" className="goal-skip" onClick={onClose}>先随便看看，不选</button>
      </div>
    </div>
  );
}
