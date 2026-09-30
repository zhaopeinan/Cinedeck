/** PPT 配音流程 Steps（7 步） */
export const PPT_WORKFLOW_STEPS = [
  { title: '导入PPT' },
  { title: '读取备注' },
  { title: '选择音色' },
  { title: '生成配音' },
  { title: '生成数字人' },
  { title: '视频预览' },
  { title: '编辑导出' },
] as const;

export const PPT_STEP = {
  IMPORT: 0,
  NOTES: 1,
  VOICE: 2,
  DUBBING: 3,
  AVATAR: 4,
  PREVIEW: 5,
  EDITOR: 6,
} as const;
