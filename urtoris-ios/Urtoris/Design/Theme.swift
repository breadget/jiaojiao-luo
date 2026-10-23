import SwiftUI

/// Urtoris 的颜色不是"一套主题"，而是四张工作台各自的材料：
/// 门厅与机器人端是冷灰纸面，创建端是黑蓝工程台，使用端是炭黑对话台。
/// 令牌与 `app/globals.css` 中的 `--urtoris-*` 变量一一对应。
enum U {
    // 门厅 · 冷灰纸面
    static let background = Color(hex: 0xE8EBE7)
    static let paper = Color(hex: 0xF7F6EF)
    static let paperBright = Color(hex: 0xFFFEF8)
    static let steel = Color(hex: 0xDFE4E0)
    static let line = Color(hex: 0xB8C1BC)
    static let headerLine = Color(hex: 0x9CA9A2)
    static let headerBackground = Color(hex: 0xF4F5F0)
    static let ink = Color(hex: 0x132B39)
    static let inkSoft = Color(hex: 0x4F6169)
    static let navy = Color(hex: 0x123142)
    static let orange = Color(hex: 0xED5A2B)
    static let orangeAction = Color(hex: 0xB83B17)
    static let green = Color(hex: 0x1D805E)
    static let yellow = Color(hex: 0xEDC94A)
    static let headerTitle = Color(hex: 0x344C58)
    static let headerState = Color(hex: 0x25424F)
    static let connectionDotRing = Color(hex: 0xD2E6DE)

    // 创建端 · 夜色工程台
    static let studioBackground = Color(hex: 0x08111A)
    static let studioPanel = Color(hex: 0x0D1822)
    static let studioLine = Color(hex: 0x263746)
    static let studioText = Color(hex: 0xEDF4F8)
    static let studioAction = Color(hex: 0xFF6B35)
    static let studioMuted = Color(hex: 0x8FA6B6)

    // 使用端 · 炭黑对话台
    static let consumerBackground = Color(hex: 0x111214)
    static let consumerSidebar = Color(hex: 0x1A1B1E)
    static let consumerRaised = Color(hex: 0x26272B)
    static let consumerRaisedHover = Color(hex: 0x303136)
    static let consumerShortcut = Color(hex: 0x3A3B40)
    static let consumerLine = Color(hex: 0x303136)
    static let consumerText = Color(hex: 0xF1F2F4)
    static let consumerMuted = Color(hex: 0xA3A6AD)
    static let consumerFaint = Color(hex: 0x757981)
    static let consumerAction = Color(hex: 0x7891C7)
    static let consumerActionHover = Color(hex: 0x8CA6DF)
    static let consumerOnAction = Color(hex: 0x101218)
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

/// 圆角与控件高度取自 DESIGN.md 的 Shapes / Buttons 章节。
enum Radius {
    static let field: CGFloat = 8
    static let control: CGFloat = 9
    static let nav: CGFloat = 11
    static let card: CGFloat = 14
    static let surface: CGFloat = 16
    static let frame: CGFloat = 18
}

enum Metrics {
    static let headerHeight: CGFloat = 68
    static let pageMaxWidth: CGFloat = 1120
    static let pagePadding: CGFloat = 20
    static let touchTarget: CGFloat = 44
    static let consumerStreamMaxWidth: CGFloat = 840
    static let consumerComposerMaxWidth: CGFloat = 860
}

extension Font {
    /// 门厅主标题：Geist Sans 780 / 紧凑字距
    static func urtorisDisplay(_ size: CGFloat = 40) -> Font {
        .system(size: size, weight: .heavy)
    }

    static func urtorisHeadline(_ size: CGFloat = 28) -> Font {
        .system(size: size, weight: .heavy)
    }

    static func urtorisBody(_ size: CGFloat = 13) -> Font {
        .system(size: size, weight: .regular)
    }

    /// 端口、版本、时间与接口路径使用的等宽标签
    static func urtorisLabel(_ size: CGFloat = 10, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

extension View {
    /// 卡片投影：默认平面，只有真实浮层才允许阴影。
    func softShadow(_ opacity: Double = 0.08, radius: CGFloat = 24, y: CGFloat = 14) -> some View {
        shadow(color: .black.opacity(opacity), radius: radius, x: 0, y: y)
    }
}

/// 门厅框架用的 1px 冷灰边界。
struct Hairline: View {
    var color: Color = U.line
    var body: some View {
        Rectangle().fill(color).frame(height: 1)
    }
}

/// 品牌图标：lucide `workflow`（左上圆角方块 → L 形连线 → 右下圆角方块）。
struct WorkflowGlyph: View {
    var color: Color = .white
    var lineWidth: CGFloat = 2.2

    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            let stroke = lineWidth * (s / 24)
            ZStack {
                RoundedRectangle(cornerRadius: 2 * (s / 24), style: .continuous)
                    .stroke(color, lineWidth: stroke)
                    .frame(width: 8 * (s / 24), height: 8 * (s / 24))
                    .position(x: 7 * (s / 24), y: 7 * (s / 24))

                Path { path in
                    path.move(to: CGPoint(x: 7 * (s / 24), y: 11 * (s / 24)))
                    path.addLine(to: CGPoint(x: 7 * (s / 24), y: 15 * (s / 24)))
                    path.addQuadCurve(
                        to: CGPoint(x: 9 * (s / 24), y: 17 * (s / 24)),
                        control: CGPoint(x: 7 * (s / 24), y: 17 * (s / 24))
                    )
                    path.addLine(to: CGPoint(x: 13 * (s / 24), y: 17 * (s / 24)))
                }
                .stroke(color, style: StrokeStyle(lineWidth: stroke, lineCap: .round, lineJoin: .round))

                RoundedRectangle(cornerRadius: 2 * (s / 24), style: .continuous)
                    .stroke(color, lineWidth: stroke)
                    .frame(width: 8 * (s / 24), height: 8 * (s / 24))
                    .position(x: 17 * (s / 24), y: 17 * (s / 24))
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}
