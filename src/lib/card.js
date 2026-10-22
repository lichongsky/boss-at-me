// 草稿通知卡片（飞书 Card 2.0）：机器人私聊给我，带可编辑的草稿、快捷回复和「发送 / 不发」按钮。
// 按钮在 form 内提交，回调里用 action_name 区分（opt_N / send / drop），用卡片的 message_id 找到对应草稿。

const CONFIDENCE = { high: '把握高', medium: '把握中', low: '把握低' };
const INPUT_MAX = 1000; // 飞书 input 组件上限

const plain = (content, extra = {}) => ({ tag: 'div', text: { tag: 'plain_text', content, ...extra } });
const clipText = (s, n) => {
  const t = String(s || '').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

function header({ code, sender, where, chatName, time, action, status }) {
  const done = { sent: ['green', '已发送'], dropped: ['grey', '已忽略'], manual: ['orange', '需手动发送'], expired: ['grey', '已过期'] }[status];
  const tags = [{ tag: 'text_tag', text: { tag: 'plain_text', content: `#${code}` }, color: 'neutral' }];
  if (done) tags.push({ tag: 'text_tag', text: { tag: 'plain_text', content: done[1] }, color: done[0] === 'grey' ? 'neutral' : done[0] });
  else if (action === 'notify') tags.push({ tag: 'text_tag', text: { tag: 'plain_text', content: '需你处理' }, color: 'orange' });
  return {
    title: { tag: 'plain_text', content: `${sender} ${where}` },
    subtitle: { tag: 'plain_text', content: [chatName, time].filter(Boolean).join(' · ') },
    template: done ? done[0] : action === 'notify' ? 'orange' : 'blue',
    text_tag_list: tags,
  };
}

function contextBlocks(p) {
  return [
    {
      tag: 'collapsible_panel',
      expanded: true,
      background_color: 'grey-50',
      padding: '8px 12px 8px 12px',
      header: { title: { tag: 'markdown', content: '**原文**' } },
      elements: [plain(p.original, { text_color: 'grey' })],
    },
    { tag: 'markdown', content: `**要点**　${p.summary}` },
    {
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'markdown', content: `<font color='grey'>依据 · ${CONFIDENCE[p.confidence] || p.confidence}</font>` } },
      elements: [plain(p.analysis, { text_size: 'notation', text_color: 'grey' })],
    },
  ];
}

/** 可疑指令 / 没有依据时的提示，放在草稿上方，避免误点发送。 */
export function warningBlocks(p) {
  const blocks = [];
  if (p.suspicious) {
    blocks.push({
      tag: 'markdown',
      content: "<font color='red'>**⚠️ 可能包含指令注入**</font>：这条消息里有「让你执行操作」的内容，发送前请确认草稿没有被操纵。",
    });
  }
  if (p.evidence === false) {
    blocks.push({ tag: 'markdown', content: "<font color='grey'>⚠️ 草稿没有引用具体代码 / 文档 / 聊天依据，建议发送前核对。</font>" });
  }
  return blocks;
}

const footer = (p, text) => ({
  tag: 'markdown',
  content: `<font color='grey'>${text}${p.link ? `　[查看原消息](${p.link})` : ''}</font>`,
  text_size: 'notation',
});

function quickOptions(p) {
  const options = Array.isArray(p.options) ? p.options.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3) : [];
  if (!options.length) return null;
  return {
    tag: 'column_set',
    horizontal_spacing: 'small',
    columns: options.map((o, i) => ({
      tag: 'column',
      width: 'auto',
      elements: [{ tag: 'button', name: `opt_${i}`, text: { tag: 'plain_text', content: clipText(o, 40) }, type: 'default', form_action_type: 'submit' }],
    })),
  };
}

/** 待确认的草稿卡片 */
export function buildDraftCard(p) {
  const elements = contextBlocks(p);
  elements.push(...warningBlocks(p));
  const editable = p.draft && p.draft.length <= INPUT_MAX;
  if (editable || !p.draft) {
    const formElements = [
      {
        tag: 'input',
        name: 'reply',
        input_type: 'multiline_text',
        rows: 3,
        auto_resize: true,
        max_rows: 10,
        max_length: INPUT_MAX,
        width: 'fill',
        // 不设 required：没有草稿时也要能点「不发」；空内容由 executeDraft 兜底提示
        required: false,
        label: { tag: 'plain_text', content: p.draft ? '回复草稿（可直接修改）' : '没有草稿，写下你的回复' },
        ...(p.draft ? { default_value: p.draft } : {}),
        placeholder: { tag: 'plain_text', content: '输入回复内容' },
      },
    ];
    const opts = quickOptions(p);
    if (opts) formElements.push(opts);
    formElements.push({
      tag: 'column_set',
      horizontal_spacing: 'small',
      columns: [
        { tag: 'column', width: 'auto', elements: [{ tag: 'button', name: 'send', text: { tag: 'plain_text', content: '发送' }, type: 'primary_filled', form_action_type: 'submit' }] },
        { tag: 'column', width: 'auto', elements: [{ tag: 'button', name: 'drop', text: { tag: 'plain_text', content: '不发' }, type: 'default', form_action_type: 'submit' }] },
      ],
    });
    elements.push({ tag: 'form', name: 'reply_form', elements: formElements });
  } else {
    // 草稿超过输入框上限：只读展示，改用文字指令修改
    elements.push({ tag: 'markdown', content: '**草稿**' }, plain(p.draft));
  }
  elements.push(footer(p, `也可以回「发 ${p.code} / 改 ${p.code} 内容 / 不发 ${p.code}」`));
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: `${p.sender}${p.where}：${p.summary}` } },
    header: header(p),
    body: { direction: 'vertical', vertical_spacing: '12px', elements },
  };
}

/** 处理完之后的卡片：去掉输入框和按钮，展示结果 */
export function buildDoneCard(p) {
  const result = {
    sent: `**已发送**\n${p.finalText || ''}`,
    dropped: '**已忽略**，没有发送任何内容',
    manual: `**自动发送失败**：${p.note || ''}\n请复制下面内容手动回复：\n${p.finalText || ''}`,
    expired: '**已过期**，没有发送任何内容',
  }[p.status];
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: header(p),
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [...contextBlocks(p), ...warningBlocks(p), { tag: 'markdown', content: result }, footer(p, `#${p.code}`)],
    },
  };
}
