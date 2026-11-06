from pathlib import Path
import sys
from PIL import Image, ImageDraw

PROJECT = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT / "design" / "source.jpg"
design = PROJECT / "design"
images = PROJECT / "public" / "images"
design.mkdir(parents=True, exist_ok=True)
images.mkdir(parents=True, exist_ok=True)

original = Image.open(source).convert("RGB")
gray = original.convert("L")
# Remove JPEG noise from the black backdrop while retaining antialiased edges.
alpha = gray.point(lambda value: 0 if value < 8 else 255 if value > 248 else round((value - 8) * 255 / 240))
bounds = alpha.getbbox()
if not bounds:
    raise RuntimeError("No white wooden-fish silhouette found")
alpha = alpha.crop(bounds)

canvas_size = 1024
art_size = 900
scale = min(art_size / alpha.width, art_size / alpha.height)
resized = alpha.resize((round(alpha.width * scale), round(alpha.height * scale)), Image.Resampling.LANCZOS)
mask = Image.new("L", (canvas_size, canvas_size), 0)
mask.paste(resized, ((canvas_size - resized.width) // 2, (canvas_size - resized.height) // 2))
fish = Image.new("RGBA", (canvas_size, canvas_size), (255, 255, 255, 0))
fish.putalpha(mask)
fish.save(design / "muyu.png", optimize=True)
fish.save(images / "muyu.webp", "WEBP", lossless=True, quality=100, method=6)

icon = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
draw = ImageDraw.Draw(icon)
draw.rounded_rectangle((20, 20, 1004, 1004), radius=220, fill=(0, 0, 0, 255))
small_mask = mask.resize((760, 760), Image.Resampling.LANCZOS)
icon_alpha = Image.new("L", (canvas_size, canvas_size), 0)
icon_alpha.paste(small_mask, (132, 132))
icon_fish = Image.new("RGBA", icon.size, (255, 255, 255, 0))
icon_fish.putalpha(icon_alpha)
icon.alpha_composite(icon_fish)
icon.save(design / "icon.png", optimize=True)

print(f"Source: {source}")
print(f"Transparent fish: {design / 'muyu.png'}")
print(f"Runtime image: {images / 'muyu.webp'} ({(images / 'muyu.webp').stat().st_size} bytes)")
print(f"App icon: {design / 'icon.png'}")
