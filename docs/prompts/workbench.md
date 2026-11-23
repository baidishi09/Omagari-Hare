# 窗边工位背景生成记录

- 日期：2026-11-24。
- 工具：内置 `image_gen`，按 imagegen 技能的默认生成流程执行。
- 类型：全新环境插画，未使用角色或其他参考图，不含人物。
- 项目文件：`assets/hare-workbench.png`。
- 输出：1536 × 1024 PNG，1,870,714 字节；原样复制到项目，没有裁切、缩放、重绘或 Python 图像编辑。
- SHA-256：`9a418318b93db7a673308399b1a5917b756beaf7d22dddcd63c88e9c30eef2d6`。

## 最终提示词

```text
Use case: illustration-story
Asset type: Wide illustrated room background for a desktop companion app, no character; target 1536 × 1024 or a near 16:10 landscape.
Primary request: A refined Japanese animation background of a quiet young engineer's window-side workbench at blue hour, cozy lived-in spatial depth, soft cel-painted forms and restrained clean linework, not photorealistic.
Scene/backdrop: An intimate small room with a muted blue-gray evening window and off-white walls. A warm small desk lamp lights the far-right corner. Keep one small plant, a few books, a restrained handful of electronics engineering objects and a single unbranded dark computer monitor along the right side and distant back edge. A few gentle distant window lights suggest evening. No dramatic vista.
Composition/framing: Straight-on with a slight downward view toward the tabletop, a steady nearly horizontal desk front edge at about 88% of image height. The lower 35% of the frame is one broad, clean, flat light-gray pale-wood tabletop with understated grain. All props stay on the far-right quarter or far back, never crossing the middle and left-center tabletop. Reserve generous unobstructed space for a separately rendered small sprite centered at x=40% with feet at y=84%; leave the entire region x=12–68%, y=42–86% visually quiet and free of objects. The top-left is muted slightly dark blue-gray, calm and uniform for a title overlay. Top-right is subdued and not bright or visually busy, for small settings controls. Camera must show an inviting usable flat surface, no tilted dramatic perspective.
Lighting/mood: Cool desaturated evening ambient light with a restrained warm desk-lamp pool on the right; gentle soft shadows, comfortable, quiet, not gloomy.
Palette/materials: Blue-gray, off-white, light natural wood, small warm amber highlights. Fine cel shading, soft hand-painted depth, crisp enough to sit behind an anime sprite.
Constraints: Environment ONLY. No person, creature, character, face, portrait, mascot, silhouette, figurine, hands, text, letters, labels, numbers, UI, logo or watermark. No icons, no HUD, no neon, no glowing grids, no particles, no decorative overlays. No clutter in the center or left-center foreground. Do not draw a character-shaped blank or placeholder.
```

## 人工查看结论与布局坐标

已查看保存到项目的最终图像。画面为日系动画风的蓝灰色窗边工位，右侧有暖光台灯、盆栽、书、示波器、焊台和显示器；没有人物、文字、标识或界面元素。左上为安静的灰蓝墙面，中央和左中部可叠加独立渲染的小钩晴精灵。

最终桌面后沿约在画面高度 68%，前沿约 93%，比提示词要求的 88% 更低；仍有足够干净、近水平的落脚面。推荐角色中心 x=40%、脚底 y=84%，使用原有透明精灵而非把角色合成进背景。

- 保持原始 3:2 比例的容器：`object-fit: cover; object-position: 50% 50%`，脚底位于容器高度 84%。
- 更宽的容器：建议 `object-position: 50% 100%` 保留桌面底部。采用 cover 时，应按裁切后的坐标计算脚底，避免直接复用 84%。
- 容器宽高分别为 `W`、`H` 时，cover 比例 `s = max(W/1536, H/1024)`；底部对齐的脚底坐标为 `H - (1 - 0.84) × 1024 × s`。16:10 容器约为 82.9% 高度。
- 避免大幅纵向裁切；标题和设置仍应由 HTML/CSS 绘制，背景中不包含任何 UI。

这里只记录背景生成与视觉查看，不代表应用界面已经集成或通过交互测试。
