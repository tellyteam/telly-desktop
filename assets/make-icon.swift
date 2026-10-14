// Draws telly's app icon (1024×1024): the white wordmark on a blue-slate tile.
// Run: swift assets/make-icon.swift assets/icon.png
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments[1]
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

// macOS icon grid: an 824px tile with ~185px corners, centred.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let path = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
NSGraphicsContext.current!.saveGraphicsState()
let shadow = NSShadow(); shadow.shadowColor = NSColor(white: 0, alpha: 0.35); shadow.shadowBlurRadius = 24; shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.set()
NSColor(srgbRed: 0.08, green: 0.10, blue: 0.13, alpha: 1).setFill(); path.fill()
NSGraphicsContext.current!.restoreGraphicsState()
let gradient = NSGradient(colors: [NSColor(srgbRed: 0x2a/255, green: 0x3a/255, blue: 0x55/255, alpha: 1),
                                   NSColor(srgbRed: 0x15/255, green: 0x1a/255, blue: 0x22/255, alpha: 1)])!
gradient.draw(in: path, angle: -60)
NSColor(srgbRed: 0x4f/255, green: 0xc3/255, blue: 0xf7/255, alpha: 0.9).setStroke()

let font = NSFont.systemFont(ofSize: 250, weight: .black)
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white, .kern: -2]
let text = NSAttributedString(string: "telly", attributes: attrs)
let b = text.size()
text.draw(at: NSPoint(x: (size - b.width) / 2, y: (size - b.height) / 2 + 8))
// A small accent bar under the wordmark, like the app's focus colour.
NSColor(srgbRed: 0x4f/255, green: 0xc3/255, blue: 0xf7/255, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: (size - 150) / 2, y: 330, width: 150, height: 18), xRadius: 9, yRadius: 9).fill()

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
