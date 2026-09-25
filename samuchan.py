from pathlib import Path
from datetime import datetime, timedelta
import json
import sys
import re
import time

from playwright.sync_api import sync_playwright


# ============================================================
# CONFIG
# ============================================================

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
PROFILE_DIR = DATA_DIR / "taobao_browser"
DEBUG_DIR = DATA_DIR / "taobao_debug"
OUTPUT_FILE = DATA_DIR / "taobao_orders.json"

PROFILE_DIR.mkdir(parents=True, exist_ok=True)
DEBUG_DIR.mkdir(parents=True, exist_ok=True)

LOGISTICS_WAIT_MS = 8000
# Chỉ đồng bộ các đơn gần đây để giảm thời gian chạy. Dữ liệu các trang cũ
# vẫn được giữ nguyên trong taobao_orders.json nhờ save_orders().
MAX_ORDER_PAGES = 2
INITIAL_SYNC_COMPLETED_KEY = "initial_sync_completed"
PAGE_WAIT_MS = 2500

# ============================================================
# BROWSER
# ============================================================


def create_browser(p):
    storage_state = DATA_DIR / "taobao_storage_state.json"

    try:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-software-rasterizer",
                "--disable-background-networking",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
            ],
        )

        context_kwargs = {
            "viewport": {"width": 1440, "height": 1000},
            "locale": "zh-CN",
            "timezone_id": "Asia/Shanghai",
        }

        if storage_state.exists() and storage_state.stat().st_size > 0:
            print("✓ Đang dùng Taobao storage state:", storage_state)
            context_kwargs["storage_state"] = str(storage_state)
        else:
            print("⚠️ Không có Taobao storage state.")

        context = browser.new_context(**context_kwargs)

        page = context.pages[0] if context.pages else context.new_page()

        return context, page

    except Exception as e:
        print("\n❌ Không thể mở browser:")
        print(e)
        return None, None
# ============================================================
# BASIC HELPERS
# ============================================================

def clean_text(text):
    if not text:
        return ""
    text = str(text).replace("\xa0", " ")
    text = re.sub(r"[ \t\r\n]+", " ", text)
    return text.strip()


def normalize_url(url):
    if not url:
        return None
    url = str(url).strip()
    if url.startswith("//"):
        return "https:" + url
    return url


def first_nonempty(values):
    for value in values:
        value = clean_text(value)
        if value:
            return value
    return None


def safe_inner_text(locator, timeout=800):
    try:
        return clean_text(locator.inner_text(timeout=timeout))
    except Exception:
        return ""


def save_debug_page(page, name):
    try:
        html_file = DEBUG_DIR / f"{name}.html"
        screenshot_file = DEBUG_DIR / f"{name}.png"
        html_file.write_text(page.content(), encoding="utf-8")
        page.screenshot(path=str(screenshot_file), full_page=True)
        print(f"  HTML: {html_file}")
        print(f"  IMG : {screenshot_file}")
    except Exception as e:
        print("⚠️ Không lưu được debug:", e)


# ============================================================
# TAOBAO NAVIGATION
# ============================================================

def open_taobao(page, interactive=True):
    print("\n🌐 Đang mở Taobao...")
    try:
        page.goto("https://www.taobao.com/", wait_until="commit", timeout=60000)
    except Exception as e:
        print("Taobao đang redirect:", str(e)[:250])

    page.wait_for_timeout(5000)
    print("URL:", page.url)

    if "passport.taobao.com" in page.url.lower():
        if not interactive:
            raise RuntimeError(
                "Taobao chưa đăng nhập trong profile. Hãy chạy python samuchan.py "
                "và chọn mục 1 để đăng nhập trước."
            )
        print("""
==================================================
⚠️ TAOBAO CHƯA ĐĂNG NHẬP
==================================================
Hãy đăng nhập trên cửa sổ browser.
Sau khi đăng nhập xong quay lại PowerShell và nhấn ENTER.
==================================================
""")
        input("Đăng nhập xong → ENTER... ")
        page.wait_for_timeout(3000)

    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    return page


def open_my_orders(page):
    print("\n🛒 Đang mở '已买到的宝贝'...")

    # Taobao thường hiển thị popup khuyến mãi phủ lên thanh điều hướng.
    # Đóng popup trước khi click link đơn hàng.
    try:
        page.keyboard.press("Escape")
        page.wait_for_timeout(1000)
    except Exception:
        pass

    selectors = [
        "text=已买到的宝贝",
        "text=已买到宝贝",
        "a:has-text('已买到的宝贝')",
        "a:has-text('已买到宝贝')",
    ]

    for selector in selectors:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible():
                print("✓ Tìm thấy:", selector)
                try:
                    loc.click(timeout=10000)
                except Exception:
                    # Một số lớp quảng cáo vẫn còn trong DOM dù đã đóng.
                    loc.click(timeout=10000, force=True)
                page.wait_for_timeout(5000)

                if len(page.context.pages) > 1:
                    for candidate in reversed(page.context.pages):
                        try:
                            if "taobao" in candidate.url.lower():
                                page = candidate
                                break
                        except Exception:
                            pass

                print("✓ URL:", page.url)
                return page
        except Exception:
            continue

    print("❌ Không tìm thấy 已买到的宝贝")
    save_debug_page(page, "cannot_open_orders")
    return None


# ============================================================
# ORDER DISCOVERY
# ============================================================

def get_order_candidates(page):
    selectors = [
        "div.trade-container-shopOrderContainer",
        "div[class*='trade-container-shopOrderContainer']",
        "div[id*='shopOrderContainer']",
        "div[id*='orderColContainer']",
        "div[class*='order-container']",
        "div[class*='orderContainer']",
        "div[class*='order-card']",
        "[data-order-id]",
    ]

    for selector in selectors:
        try:
            loc = page.locator(selector)
            count = loc.count()
            if count:
                visible = []
                for i in range(count):
                    try:
                        if loc.nth(i).is_visible():
                            visible.append(loc.nth(i))
                    except Exception:
                        pass
                if selector not in {
                    "div.trade-container-shopOrderContainer",
                    "div[class*='trade-container-shopOrderContainer']",
                }:
                    visible = [
                        item for item in visible
                        if extract_order_id(item)
                    ]
                print(f"\n🔎 Order container: {selector}")
                print(f"✓ Tìm được {len(visible)} ORDER CARD")
                # Một số phiên bản Taobao vẫn giữ template cũ trong DOM
                # nhưng ẩn nó. Chỉ dừng khi thật sự có card đang hiển thị.
                if visible:
                    return visible
        except Exception:
            pass

    # Fallback cuối: tìm các block có mã đơn trong text. Cách này chịu được
    # việc Taobao đổi tên class CSS, miễn là nội dung "订单号" vẫn còn.
    try:
        all_blocks = page.locator(
            "div[class*='order'], div[id*='order'], "
            "div[class*='trade'], div[id*='trade'], "
            "div[class*='shop'], div[id*='shop']"
        )
        matches = {}
        for i in range(min(all_blocks.count(), 4000)):
            block = all_blocks.nth(i)
            try:
                if not block.is_visible():
                    continue
                order_id = extract_order_id(block)
                if not order_id:
                    continue
                class_name = (
                    block.get_attribute("class") or ""
                ).lower()
                block_id = (block.get_attribute("id") or "").lower()
                if not any(
                    word in f"{class_name} {block_id}"
                    for word in ("order", "trade", "shop")
                ):
                    continue
                text_length = len(safe_inner_text(block, 1200))
                current = matches.get(order_id)
                if current is None or text_length < current[0]:
                    matches[order_id] = (text_length, block)
            except Exception:
                continue

        fallback = [item[1] for item in matches.values()]
        if fallback:
            print(
                f"\n🔎 Fallback text ORDER CARD: {len(fallback)} card"
            )
            return fallback
    except Exception:
        pass

    print("❌ Không tìm thấy ORDER CARD")
    save_debug_page(page, "order_container_not_found")
    return []


# ============================================================
# EXACT ORDER PARSER
# ============================================================

def extract_order_id(order):
    try:
        el = order.locator("span[class*='shopInfoOrderId']").first
        t = safe_inner_text(el, 1000)
        m = re.search(r"(?:订单号|订单编号)[:：\s]*([0-9]{10,30})", t)
        if m:
            return m.group(1)
    except Exception:
        pass

    try:
        cid = order.get_attribute("id") or ""
        m = re.search(r"(?:shopOrderContainer|orderColContainer|orderDetailCol)_(\d{10,30})", cid)
        if m:
            return m.group(1)
    except Exception:
        pass

    for attr in ("data-order-id", "data-orderid", "data-id"):
        try:
            value = order.get_attribute(attr) or ""
            m = re.search(r"([0-9]{10,30})", value)
            if m:
                return m.group(1)
        except Exception:
            pass

    try:
        text = safe_inner_text(order, 1200)
        m = re.search(
            r"(?:订单号|订单编号|Order\s*ID)\s*[:：#]?\s*([0-9]{10,30})",
            text,
            re.I,
        )
        if m:
            return m.group(1)
    except Exception:
        pass

    return None


def extract_shop(order):
    for selector in [
        "span[class*='shopInfoNameContainer'] a",
        "a[class*='shopInfoName']",
    ]:
        try:
            value = safe_inner_text(order.locator(selector).first, 1000)
            if value:
                return value
        except Exception:
            pass
    return None


def extract_order_date(order):
    try:
        return first_nonempty([
            safe_inner_text(order.locator("span[class*='shopInfoOrderTime']").first, 1000)
        ])
    except Exception:
        return None


def extract_image(item):
    try:
        anchors = item.locator("a[class*='image']")
        if anchors.count():
            style = anchors.first.get_attribute("style") or ""
            m = re.search(r"url\([\"']?(.*?)[\"']?\)", style)
            if m:
                return normalize_url(m.group(1))
    except Exception:
        pass

    try:
        img = item.locator("img").first
        return normalize_url(first_nonempty([
            img.get_attribute("src"),
            img.get_attribute("data-src"),
            img.get_attribute("data-lazy-src"),
        ]))
    except Exception:
        return None


def extract_product_name(item):
    selectors = [
        "a[class*='title'] span[class*='titleText']",
        "span[class*='titleText']",
        "a[class*='title']",
    ]
    for selector in selectors:
        try:
            value = safe_inner_text(item.locator(selector).first, 1000)
            if value:
                return value
        except Exception:
            pass
    return None


def extract_sku(item):
    try:
        infos = item.locator("div[class*='infoContent']")
        values = []
        for i in range(min(infos.count(), 8)):
            text = safe_inner_text(infos.nth(i), 1000)
            if text and not any(x in text for x in ["天价保", "极速退款", "无理由退货"]):
                values.append(text)
        return values[0] if values else None
    except Exception:
        return None


def extract_quantity(item):
    try:
        q = item.locator("div[class*='quantity']").first
        text = safe_inner_text(q, 1000)
        m = re.search(r"[x×]\s*(\d+)", text, re.I)
        if m:
            return int(m.group(1))
    except Exception:
        pass
    return 1


def extract_unit_price(item):
    try:
        prices = item.locator("div.trade-price-container")
        if prices.count():
            text = safe_inner_text(prices.nth(0), 1000)
            m = re.search(r"[¥￥]?\s*(\d+(?:\.\d+)?)", text)
            if m:
                return float(m.group(1))
    except Exception:
        pass
    return 0.0


def extract_order_total(order):
    try:
        box = order.locator("div[class*='orderPaymentCol']").first
        text = safe_inner_text(box, 1500)
        m = re.search(r"实付款\s*[¥￥]?\s*(\d+(?:\.\d+)?)", text)
        if m:
            return float(m.group(1))
    except Exception:
        pass

    try:
        real = order.locator("div[class*='priceReal']").first
        text = safe_inner_text(real, 1000)
        m = re.search(r"[¥￥]?\s*(\d+(?:\.\d+)?)", text)
        if m:
            return float(m.group(1))
    except Exception:
        pass
    return 0.0


def extract_items(order):
    items = order.locator("div[class*='itemInfo'][class*='trade-bought-list-order-info']")
    result = []

    for i in range(items.count()):
        item = items.nth(i)
        try:
            name = extract_product_name(item)
            if not name:
                continue

            result.append({
                "product_name": name,
                "sku": extract_sku(item),
                "quantity": extract_quantity(item),
                "unit_price_cny": extract_unit_price(item),
                "image": extract_image(item),
            })
        except Exception as e:
            print(f"  ⚠️ Item {i + 1} lỗi: {str(e)[:150]}")

    return result


# ============================================================
# EXISTING DATA
# ============================================================

def load_existing_orders():
    if not OUTPUT_FILE.exists():
        return {}
    try:
        payload = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
        orders = payload.get("orders", [])
        return {
            str(o.get("order_id")): o
            for o in orders
            if o.get("order_id")
        }
    except Exception as e:
        print("⚠️ Không đọc được dữ liệu cũ:", e)
        return {}


# ============================================================
# LOGISTICS / NETWORK INTERCEPTION
# ============================================================

TRACKING_KEY_WORDS = (
    "mailno", "mail_no", "waybill", "waybillno", "waybill_no",
    "logisticcode", "logistic_code", "tracking", "trackingnumber",
    "tracking_number", "运单号", "物流单号", "快递单号", "运单编号",
    "物流编号", "物流单号",
)

CARRIER_KEY_WORDS = (
    "company", "companyname", "logisticcompany", "logistic_company",
    "express", "expressname", "物流公司", "快递公司", "承运商",
)


def normalize_tracking(value):
    if value is None:
        return None
    value = clean_text(value)
    value = value.strip("\"'[](){}")
    if not value or len(value) < 6 or len(value) > 40:
        return None
    if value.lower() in {"null", "none", "undefined", "unknown", "false"}:
        return None
    # Avoid ordinary money/order labels.
    if re.fullmatch(r"\d+(?:\.\d+)?", value):
        if len(value) < 8:
            return None
    return value


def tracking_score(value, key=""):
    value = normalize_tracking(value)
    if not value:
        return -1

    key_l = str(key).lower()
    score = 0
    if any(word in key_l for word in TRACKING_KEY_WORDS):
        score += 100
    if re.fullmatch(r"\d{8,25}", value):
        score += 20
    elif re.fullmatch(r"[A-Za-z0-9\-]{8,35}", value):
        score += 10
    if len(value) == 19 and value.isdigit():
        # Taobao order IDs are commonly 19 digits; penalize when the key is generic.
        if not any(word in key_l for word in TRACKING_KEY_WORDS):
            score -= 15
    return score


def walk_json(obj, path=""):
    if isinstance(obj, dict):
        for key, value in obj.items():
            current = f"{path}.{key}" if path else str(key)
            yield current, key, value
            yield from walk_json(value, current)
    elif isinstance(obj, list):
        for i, value in enumerate(obj):
            current = f"{path}[{i}]"
            yield current, str(i), value
            yield from walk_json(value, current)


def extract_tracking_from_json(data):
    best = None
    best_score = -1

    for path, key, value in walk_json(data):
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            score = tracking_score(str(value), key)
            if score > best_score:
                best = normalize_tracking(value)
                best_score = score

    return best


def extract_tracking_from_text(text):
    text = clean_text(text)
    if not text:
        return None

    patterns = [
        r"(?:运单号|物流单号|快递单号|运单编号|物流编号)\s*[:：]?\s*([A-Za-z0-9\-]{6,40})",
        r"(?:mailNo|mail_no|waybillNo|waybill_no|logisticCode|trackingNumber|tracking_number)\s*[=:]\s*[\"']?([A-Za-z0-9\-]{6,40})",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, re.I)
        if m:
            value = normalize_tracking(m.group(1))
            if value:
                return value
    return None


def extract_event_time(text, event_words):
    """Return a timestamp near the specified logistics event words."""
    if not text:
        return None

    normalized = str(text).replace("T", " ")
    date_patterns = [
        r"(20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)",
        r"(20\d{2}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}(?::\d{2})?)",
        r"(20\d{2}[-/]\d{1,2}[-/]\d{1,2})",
    ]

    for event in re.finditer(event_words, normalized, re.I):
        left = max(0, event.start() - 220)
        right = min(len(normalized), event.end() + 220)
        window = normalized[left:right]
        for pattern in date_patterns:
            m = re.search(pattern, window)
            if m:
                return m.group(1)
    return None


def extract_delivery_event(text):
    """Return delivery/receipt timestamp when Taobao explicitly reports delivery."""
    return extract_event_time(
        text,
        r"(?:已签收|签收|已送达|送达|妥投|已到达驿站|已取件|收件人已签收)"
    )


def extract_shipping_event(text):
    """Return shipment timestamp when Taobao explicitly reports dispatch."""
    return extract_event_time(
        text,
        r"(?:已发货|卖家已发货|包裹已出库|已出库|揽收|已揽收|快递员已取件)"
    )


def response_is_logistics(response):
    url = (response.url or "").lower()
    return (
        "mtop" in url
        or "logistic" in url
        or "wuliu" in url
        or "trace" in url
        or "delivery" in url
        or "trade" in url
    )


def collect_network_response(response, bucket):
    try:
        if not response_is_logistics(response):
            return

        content_type = (response.headers.get("content-type") or "").lower()
        if not any(x in content_type for x in ["json", "javascript", "text", "html"]):
            return

        body = response.text()
        if not body or len(body) > 5_000_000:
            return

        tracking = extract_tracking_from_text(body)
        delivery = extract_delivery_event(body)
        shipped = extract_shipping_event(body)

        if not tracking:
            try:
                data = json.loads(body)
                tracking = extract_tracking_from_json(data)
            except Exception:
                pass

        # Keep only responses that have a useful logistics signal.
        if tracking or delivery or shipped or any(word in body for word in ["运单号", "物流单号", "已签收", "已发货", "mailNo"]):
            bucket.append({
                "url": response.url,
                "tracking": tracking,
                "delivered_at": delivery,
                "shipped_at": shipped,
                "body": body[:200000],
            })
    except Exception:
        pass


def captcha_detected(page):
    try:
        text = safe_inner_text(page.locator("body"), 1000)
        markers = [
            "亲，请拖动下方滑块完成验证",
            "验证失败，点击重试",
            "验证失败",
            "请拖动下方滑块",
        ]
        return any(marker in text for marker in markers)
    except Exception:
        return False


def click_view_logistics(page, container):
    selectors = [
        "a:has-text('查看物流')",
        "button:has-text('查看物流')",
        "text=查看物流",
    ]

    for selector in selectors:
        try:
            loc = container.locator(selector).first
            if loc.count() and loc.is_visible():
                loc.scroll_into_view_if_needed()
                loc.click(timeout=5000)
                return True
        except Exception:
            pass

    # Sometimes the button is rendered outside the strict order container.
    for selector in selectors:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible():
                loc.click(timeout=5000)
                return True
        except Exception:
            pass

    return False


def extract_tracking_from_logistics_page(page):
    """Try DOM/text extraction after network interception has already run."""
    try:
        text = safe_inner_text(page.locator("body"), 3000)
    except Exception:
        text = ""

    tracking = extract_tracking_from_text(text)
    delivered = extract_delivery_event(text)
    shipped = extract_shipping_event(text)

    if tracking or delivered or shipped:
        return tracking, delivered, shipped

    # Search visible elements whose attributes/classes look logistics-related.
    try:
        elements = page.locator("*[class*='logistic'], *[class*='Logistic'], *[class*='mail'], *[class*='waybill']")
        for i in range(min(elements.count(), 100)):
            el = elements.nth(i)
            txt = safe_inner_text(el, 300)
            tracking = extract_tracking_from_text(txt)
            delivered = extract_delivery_event(txt)
            shipped = extract_shipping_event(txt)
            if tracking or delivered or shipped:
                return tracking, delivered, shipped
    except Exception:
        pass

    return None, None, None


def get_logistics_data(page, container, index):
    """
    Open logistics and listen to Taobao's network responses.
    This does NOT automate/bypass CAPTCHA.
    """
    responses = []

    def handler(response):
        collect_network_response(response, responses)

    page.context.on("response", handler)

    original_page = page
    opened_page = None

    try:
        before_pages = set(page.context.pages)

        if not click_view_logistics(page, container):
            return None, None, None, "Không tìm thấy nút 查看物流"

        # Wait briefly for popup/tab or in-page logistics panel.
        deadline = time.time() + LOGISTICS_WAIT_MS / 1000
        while time.time() < deadline:
            new_pages = [p for p in page.context.pages if p not in before_pages]
            if new_pages:
                opened_page = new_pages[-1]
                try:
                    opened_page.wait_for_load_state("domcontentloaded", timeout=3000)
                except Exception:
                    pass
                break
            page.wait_for_timeout(250)

        target = opened_page or original_page
        target.wait_for_timeout(2500)

        # First priority: network responses collected from mtop/logistics calls.
        best_tracking = None
        best_delivery = None
        best_shipped = None
        for item in responses:
            if item.get("tracking") and not best_tracking:
                best_tracking = item["tracking"]
            if item.get("delivered_at") and not best_delivery:
                best_delivery = item["delivered_at"]
            if item.get("shipped_at") and not best_shipped:
                best_shipped = item["shipped_at"]

        # Second priority: rendered page, if available.
        dom_tracking, dom_delivery, dom_shipped = extract_tracking_from_logistics_page(target)
        best_tracking = best_tracking or dom_tracking
        best_delivery = best_delivery or dom_delivery
        best_shipped = best_shipped or dom_shipped

        if best_tracking or best_delivery:
            print(f"  ✓ Network/DOM tracking: {best_tracking}")
            print(f"  ✓ Shipped event: {best_shipped}")
            print(f"  ✓ Delivered event: {best_delivery}")
            return best_tracking, best_delivery, best_shipped, None

        if captcha_detected(target):
            debug_name = f"logistics_captcha_{index}"
            save_debug_page(target, debug_name)
            print("  ⚠️ Taobao logistics bị CAPTCHA chặn.")
            print("  → Không coi đây là 'không có tracking'.")
            return None, None, None, "Taobao logistics bị CAPTCHA chặn"

        if responses:
            print(f"  ℹ️ Đã bắt {len(responses)} response logistics nhưng chưa tìm thấy tracking.")
            return None, None, None, "Đã gọi logistics nhưng chưa tìm thấy tracking"

        return None, None, None, "Không nhận được response logistics"

    finally:
        try:
            page.context.remove_listener("response", handler)
        except Exception:
            pass

        if opened_page:
            try:
                opened_page.close()
            except Exception:
                pass


def parse_date_only(value):
    if not value:
        return None
    text = clean_text(value)
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y年%m月%d日", "%d/%m/%Y"):
        try:
            return datetime.strptime(text[:10], fmt).date()
        except Exception:
            pass
    m = re.search(r"(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})", text)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3))).date()
        except Exception:
            pass
    return None


def logistics_status(existing_status, existing_tracking, existing_delivered, tracking, delivered_at, shipped_at, logistics_error, has_view_logistics):
    """Status is evidence-based; tracking alone is NOT enough to claim in-transit."""
    if delivered_at or existing_delivered:
        return "Đã giao"
    if shipped_at:
        return "Đang vận chuyển"
    if tracking or existing_tracking:
        # A tracking number proves a shipment identifier exists, but not its current state.
        # If Taobao logistics is inaccessible (e.g. CAPTCHA), do not invent a status.
        if logistics_error:
            return "Không xác minh được"
        return "Đang vận chuyển"
    if has_view_logistics and logistics_error:
        return "Không xác minh được"
    if existing_status in {"Đã giao", "Đang vận chuyển"} and logistics_error:
        return existing_status
    return "Chưa giao"


# ============================================================
# PARSE ONE ORDER
# ============================================================
def parse_order(
    page,
    container,
    index,
    existing_orders,
    fetch_logistics=False,
):
    order_id = extract_order_id(container)
    shop = extract_shop(container)
    order_date = extract_order_date(container)
    order_total = extract_order_total(container)
    items = extract_items(container)

    old = existing_orders.get(str(order_id), {}) if order_id else {}

    existing_tracking = old.get("tracking_number")
    existing_tracking_source = old.get("tracking_source")
    existing_delivered = old.get("delivered_to_china_at")

    print(f"\n[{index}]")
    print("Order ID:", order_id)
    print("Shop:", shop)
    print("Ngày đặt:", order_date)
    print("Số item:", len(items))

    for j, item in enumerate(items, 1):
        print(f"  Item {j}: {item['product_name']}")
        print(f"    SKU: {item['sku']}")
        print(
            f"    SL: {item['quantity']} | "
            f"Giá: ¥{item['unit_price_cny']:.2f}"
        )

    print(f"Tổng đơn: ¥{order_total:.2f}")

    # --------------------------------------------------------
    # GIỮ DỮ LIỆU LOGISTICS CŨ
    # --------------------------------------------------------
    tracking = existing_tracking
    tracking_source = (
        existing_tracking_source
        or ("taobao" if existing_tracking else None)
    )

    delivered_at = existing_delivered
    shipped_at = old.get("shipped_at")
    previous_status = old.get("status")
    logistics_error = None

    # --------------------------------------------------------
    # FULL SYNC:
    # KHÔNG mở 查看物流 để tránh Chromium crash.
    #
    # Sau khi lấy xong toàn bộ order history,
    # logistics sẽ được xử lý bằng cơ chế riêng.
    # --------------------------------------------------------
    if fetch_logistics:
        try:
            text = safe_inner_text(container, 6000)
            has_view_logistics = "查看物流" in text

            if has_view_logistics:
                print(
                    "🚚 Có 查看物流 → bắt network để lấy tracking..."
                )

                try:
                    (
                        new_tracking,
                        new_delivered,
                        new_shipped,
                        error,
                    ) = get_logistics_data(
                        page,
                        container,
                        index,
                    )

                    if new_tracking:
                        # Không ghi đè tracking nhập tay.
                        if tracking_source != "manual":
                            tracking = new_tracking
                            tracking_source = "taobao"

                    if new_delivered:
                        delivered_at = new_delivered

                    if new_shipped:
                        shipped_at = new_shipped

                    logistics_error = error

                except Exception as e:
                    logistics_error = str(e)[:300]
                    print(
                        "  ⚠️ Lỗi logistics:",
                        logistics_error,
                    )

            else:
                print(
                    "ℹ️ Không có 查看物流 → "
                    "giữ tracking/delivery cũ nếu có."
                )

        except Exception as e:
            logistics_error = str(e)[:300]
            print(
                "  ⚠️ Không thể đọc logistics:",
                logistics_error,
            )

    else:
        print(
            "⏭️ Bỏ qua 查看物流 trong FULL SYNC "
            "→ ưu tiên lấy toàn bộ đơn hàng."
        )

    # --------------------------------------------------------
    # STATUS
    # --------------------------------------------------------
    status = logistics_status(
        existing_status=previous_status,
        existing_tracking=existing_tracking,
        existing_delivered=existing_delivered,
        tracking=tracking,
        delivered_at=delivered_at,
        shipped_at=shipped_at,
        logistics_error=logistics_error,
        has_view_logistics=(
            "查看物流" in safe_inner_text(container, 6000)
            if fetch_logistics
            else False
        ),
    )

    print("Trạng thái:", status)
    print("Tracking:", tracking)
    print("Ngày tới kho TQ:", delivered_at)

    if logistics_error:
        print("Logistics note:", logistics_error)

    return {
        "order_id": order_id,
        "shop_name": shop,
        "order_date": order_date,
        "order_total_cny": order_total,
        "items": items,
        "status": status,
        "tracking_number": tracking,
        "tracking_source": tracking_source,
        "shipped_at": shipped_at,
        "delivered_to_china_at": delivered_at,
        "logistics_note": logistics_error,
    }

# ============================================================
# PAGINATION / FULL HISTORY
# ============================================================

def get_page_signature(page):
    try:
        ids = []
        cards = get_order_candidates(page)
        for card in cards[:5]:
            oid = extract_order_id(card)
            if oid:
                ids.append(oid)
        return "|".join(ids)
    except Exception:
        return ""


def click_next_order_page(page):
    selectors = [
        "button:has-text('下一页')",
        "a:has-text('下一页')",
        "text=下一页",
        "[aria-label*='下一页']",
        "[title*='下一页']",
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector).last
            if not loc.count() or not loc.is_visible():
                continue
            disabled = loc.get_attribute("disabled")
            aria_disabled = loc.get_attribute("aria-disabled")
            cls = (loc.get_attribute("class") or "").lower()
            if disabled is not None or aria_disabled == "true" or "disabled" in cls:
                continue
            loc.scroll_into_view_if_needed()
            before = get_page_signature(page)
            loc.click(timeout=8000)
            deadline = time.time() + 12
            while time.time() < deadline:
                page.wait_for_timeout(500)
                after = get_page_signature(page)
                if after and after != before:
                    page.wait_for_timeout(PAGE_WAIT_MS)
                    return True
            return False
        except Exception:
            continue
    return False


def is_initial_sync_completed():
    if not OUTPUT_FILE.exists():
        return False

    try:
        payload = json.loads(
            OUTPUT_FILE.read_text(encoding="utf-8")
        )
        return bool(
            payload.get(INITIAL_SYNC_COMPLETED_KEY, False)
        )
    except Exception:
        return False


def scrape_all_order_pages(page):
    all_orders = []
    seen = set()
    existing_orders = load_existing_orders()
    visited_signatures = set()

    initial_sync = not is_initial_sync_completed()

    if initial_sync:
        print("\n" + "=" * 60)
        print("🟢 LẦN ĐẦU ĐỒNG BỘ TAOBAO")
        print("🟢 Sẽ quét TOÀN BỘ lịch sử đơn hàng")
        print("=" * 60)
    else:
        print("\n" + "=" * 60)
        print("🔄 ĐỒNG BỘ TAOBAO")
        print(f"🔄 Chỉ quét {MAX_ORDER_PAGES} trang mới nhất")
        print("=" * 60)

    page_no = 1

    while True:
        print(
            f"\n================ TRANG ĐƠN {page_no} ================"
        )

        try:
            page.evaluate(
                "window.scrollTo(0, document.body.scrollHeight)"
            )
            page.wait_for_timeout(1200)
        except Exception:
            pass

        signature = get_page_signature(page)

        if signature and signature in visited_signatures:
            print("⚠️ Trang bị lặp → dừng phân trang.")
            break

        if signature:
            visited_signatures.add(signature)

        candidates = get_order_candidates(page)

        if not candidates:
            print("⚠️ Không có order card → dừng.")
            break
        for local_i, container in enumerate(
            candidates,
            start=1
        ):
            try:
                order = parse_order(
                    page,
                    container,
                    f"{page_no}.{local_i}",
                    existing_orders,
                    fetch_logistics=False,
                )

                key = order.get("order_id") or (
                    order.get("shop_name"),
                    order.get("order_date"),
                    page_no,
                    local_i,
                )

                if key in seen:
                    continue

                seen.add(key)
                all_orders.append(order)

            except Exception as e:
                print(
                    f"[{page_no}.{local_i}] Parse error:",
                    str(e)[:250],
                )
                print(
                    f"[{page_no}.{local_i}] Parse error:",
                    str(e)[:250],
                )

        print(
            f"✓ Trang {page_no}: "
            f"{len(candidates)} order card; "
            f"tổng đã đọc: {len(all_orders)}"
        )

        # Lần đầu: tiếp tục cho tới khi hết trang.
        if initial_sync:
            if not click_next_order_page(page):
                print("✓ Đã đọc hết toàn bộ lịch sử Taobao.")
                break

            page_no += 1
            continue

        # Các lần sau: chỉ đọc 2 trang mới nhất.
        if page_no >= MAX_ORDER_PAGES:
            print(
                f"✓ Đã đọc {MAX_ORDER_PAGES} trang mới nhất."
            )
            break

        if not click_next_order_page(page):
            print("✓ Không còn trang tiếp theo.")
            break

        page_no += 1

    return all_orders


# ============================================================
# SCRAPE CURRENT PAGE
# ============================================================

def scrape_orders(page):
    print("""
========================================
      ĐỌC TOÀN BỘ ĐƠN HÀNG TAOBAO
========================================
""")

    # Không chụp screenshot production vì Chromium Railway
    # có thể crash khi render screenshot.
    # save_debug_page(page, "orders_before_parse")

    orders = scrape_all_order_pages(page)

    print(
        f"\n✓ Đã nhận diện {len(orders)} ORDER CARD "
        f"trên toàn bộ các trang đã đọc"
    )

    if not orders:
        try:
            url = page.url
            body_text = safe_inner_text(page.locator("body"), 2000).lower()
            if "passport.taobao.com" in url.lower() or any(
                keyword in body_text
                for keyword in ("请登录", "登录淘宝", "扫码登录", "验证码")
            ):
                raise RuntimeError(
                    "Taobao hết phiên đăng nhập trên Railway. "
                    "Cần cập nhật lại taobao_storage_state.json."
                )
            raise RuntimeError(
                "Không tìm thấy order card trên Taobao "
                f"(URL: {url}). Có thể giao diện Taobao đã đổi hoặc trang "
                "chưa tải xong; dữ liệu cũ chưa bị thay đổi."
            )
        except RuntimeError:
            raise
        except Exception:
            pass
        raise RuntimeError(
            "Taobao scrape trả về 0 đơn. Không cập nhật dữ liệu cũ."
        )

    return orders

# ============================================================
# SAVE / TOTALS
# ============================================================

def calculate_totals(orders):
    total_quantity = sum(
        int(item.get("quantity", 0) or 0)
        for order in orders
        for item in order.get("items", [])
    )
    total_cny = sum(
        float(order.get("order_total_cny", 0) or 0)
        for order in orders
    )
    return total_quantity, total_cny


def save_orders(orders):
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    old = load_existing_orders()
    merged = dict(old)

    for order in orders:
        oid = order.get("order_id")

        if not oid:
            continue

        previous = merged.get(str(oid), {})

        # Giữ tracking cũ nếu Taobao lần này không lấy được.
        if (
            not order.get("tracking_number")
            and previous.get("tracking_number")
        ):
            order["tracking_number"] = previous["tracking_number"]

        # Tracking nhập tay luôn được ưu tiên giữ lại.
        if previous.get("tracking_source") == "manual":
            order["tracking_number"] = previous.get(
                "tracking_number"
            )
            order["tracking_source"] = "manual"

        elif (
            order.get("tracking_number")
            and not order.get("tracking_source")
        ):
            order["tracking_source"] = (
                previous.get("tracking_source")
                or "taobao"
            )

        # Giữ ngày tới kho TQ cũ nếu lần này không lấy được.
        if (
            not order.get("delivered_to_china_at")
            and previous.get("delivered_to_china_at")
        ):
            order["delivered_to_china_at"] = (
                previous["delivered_to_china_at"]
            )

        # Không hạ trạng thái đã xác minh trước đó.
        if (
            order.get("delivered_to_china_at")
            or previous.get("delivered_to_china_at")
        ):
            order["status"] = "Đã giao"

        elif order.get("shipped_at"):
            order["status"] = "Đang vận chuyển"

        elif (
            order.get("status") == "Không xác minh được"
            and previous.get("status")
            in {"Đã giao", "Đang vận chuyển"}
        ):
            order["status"] = previous["status"]

        previous_tracking = previous.get("tracking_number")
        current_tracking = order.get("tracking_number")

        # Giữ dữ liệu Tuấn Vĩnh đã lưu nếu tracking không đổi. Sync Taobao
        # không nên xóa lịch sử/cân nặng; chỉ nút update Tuấn Vĩnh mới làm mới.
        if (
            current_tracking
            and previous_tracking
            and str(current_tracking).strip() == str(previous_tracking).strip()
        ):
            if previous.get("tuanvinh") and not order.get("tuanvinh"):
                order["tuanvinh"] = previous["tuanvinh"]

            if previous.get("tuanvinh_locked") is not None:
                order["tuanvinh_locked"] = previous["tuanvinh_locked"]

        # Merge theo Order ID.
        merged[str(oid)] = order

    final_orders = list(merged.values())

    payload = {
        "updated_at": datetime.now().isoformat(
            timespec="seconds"
        ),
        INITIAL_SYNC_COMPLETED_KEY: True,
        "orders": final_orders,
    }

    OUTPUT_FILE.write_text(
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    return final_orders

# ============================================================
# MANUAL TRACKING
# ============================================================

def input_missing_tracking(orders):
    """
    Cho phép nhập tracking thủ công cho các đơn chưa có tracking.
    Dữ liệu được lưu theo Order ID và đánh dấu tracking_source=manual.
    Có thể bỏ qua bằng cách ENTER.
    """
    missing = [
        o for o in orders
        if o.get("order_id") and not o.get("tracking_number")
    ]

    if not missing:
        return orders

    print("\n============================================================")
    print("NHẬP TRACKING THỦ CÔNG")
    print("============================================================")
    print(f"Có {len(missing)} đơn chưa có tracking.")
    print("ENTER để bỏ qua đơn đó. Tracking nhập tay sẽ được giữ nguyên ở các lần chạy sau.")

    for order in missing:
        oid = order.get("order_id")
        shop = order.get("shop_name") or "-"
        date = order.get("order_date") or "-"
        print(f"\nOrder ID: {oid}")
        print(f"Shop: {shop}")
        print(f"Ngày đặt: {date}")
        value = input("Tracking number (ENTER để bỏ qua): ").strip()
        if value:
            order["tracking_number"] = value
            order["tracking_source"] = "manual"
            # Chỉ thay trạng thái nếu chưa có bằng chứng giao hàng.
            if not order.get("delivered_to_china_at"):
                order["status"] = "Đang vận chuyển"
            print(f"✓ Đã lưu tracking thủ công: {value}")

    return orders


# ============================================================
# DASHBOARD
# ============================================================

def show_dashboard(orders):
    total_quantity, total_cny = calculate_totals(orders)

    print("""
============================================================
                 SAMUCHAN
                 PURCHASE DASHBOARD
============================================================
""")
    print(f"📦 TỔNG SẢN PHẨM : {total_quantity}")
    print(f"💴 TỔNG TIỀN      : ¥{total_cny:,.2f}")
    print(f"🧾 SỐ ĐƠN         : {len(orders)}")
    print("\n------------------------------------------------------------")
    print("STT | SHOP | SẢN PHẨM | SKU | SL | GIÁ ¥ | TRẠNG THÁI | TRACKING | TỚI KHO TQ")
    print("------------------------------------------------------------")

    row = 0
    for order in orders:
        for item in order.get("items", []):
            row += 1
            shop = (order.get("shop_name") or "-")[:25]
            name = (item.get("product_name") or "-")[:48]
            sku = (item.get("sku") or "-")[:25]
            qty = item.get("quantity", 0)
            price = float(item.get("unit_price_cny", 0) or 0)
            status = order.get("status") or "Chưa giao"
            tracking = order.get("tracking_number") or "Chưa có"
            if order.get("tracking_source") == "manual":
                tracking = f"{tracking} (tay)"
            delivered = order.get("delivered_to_china_at") or "Chưa xác định"

            print(
                f"{row:02d} | {shop:<25} | {name:<48} | "
                f"{sku:<25} | {qty:>3} | ¥{price:>8.2f} | "
                f"{status:<14} | {tracking:<18} | {delivered}"
            )

    print("\n============================================================")
    print(f"💾 Dữ liệu: {OUTPUT_FILE}")


# ============================================================
# RUN
# ============================================================

def run_taobao(interactive=True):
    with sync_playwright() as p:
        context, page = create_browser(p)
        if context is None:
            return False

        try:
            open_taobao(page, interactive=interactive)
            page = open_my_orders(page)
            if page is None:
                return False

            orders = scrape_orders(page)
            if interactive:
                orders = input_missing_tracking(orders)
            final_orders = save_orders(orders)
            show_dashboard(final_orders)

            if interactive:
                input("\nENTER để đóng browser...")
            return True
        finally:
            try:
                context.close()
            except Exception:
                pass


def check_profile():
    with sync_playwright() as p:
        context, page = create_browser(p)
        if context is None:
            return
        try:
            open_taobao(page)
            print("\n✓ Profile đang dùng:", PROFILE_DIR)
            print("✓ URL:", page.url)
            input("\nENTER để đóng browser...")
        finally:
            try:
                context.close()
            except Exception:
                pass


# ============================================================
# EDIT EXISTING TRACKING
# ============================================================

def edit_existing_tracking():
    """Sửa tracking đã tồn tại theo Order ID và đánh dấu là manual."""
    orders = load_existing_orders()
    if not orders:
        print("\n⚠️ Chưa có dữ liệu đơn hàng.")
        return

    print("\n============================================================")
    print("SỬA TRACKING NUMBER")
    print("============================================================")
    print("Nhập Order ID để sửa tracking. ENTER để thoát.")

    while True:
        oid = input("\nOrder ID (ENTER để thoát): ").strip()
        if not oid:
            break

        order = orders.get(str(oid))
        if not order:
            print("❌ Không tìm thấy Order ID.")
            continue

        current = order.get("tracking_number") or "Chưa có"
        print(f"Tracking hiện tại: {current}")
        value = input("Tracking mới (ENTER để hủy): ").strip()

        if not value:
            print("↩️ Không thay đổi.")
            continue

        order["tracking_number"] = value
        order["tracking_source"] = "manual"
        order["logistics_note"] = "Tracking được chỉnh thủ công."
        save_orders(list(orders.values()))
        orders = load_existing_orders()
        print(f"✓ Đã lưu tracking mới: {value}")


def main():
    print("""
============================================================
                 SAMUCHAN
============================================================

1. Chạy lấy dữ liệu Taobao
2. Kiểm tra profile đăng nhập
3. Sửa tracking theo Order ID
4. Thoát

============================================================
""")

    choice = input("Chọn: ").strip()

    if choice == "1":
        run_taobao()
    elif choice == "2":
        check_profile()
    elif choice == "3":
        edit_existing_tracking()
    elif choice == "4":
        print("Thoát.")
    else:
        print("Lựa chọn không hợp lệ.")


if __name__ == "__main__":
    if "--sync" in sys.argv:
        try:
            success = run_taobao(interactive=False)
            raise SystemExit(0 if success else 1)
        except Exception as error:
            # Backend dùng dòng này để hiển thị lỗi thực tế thay vì log dọn
            # dẹp Chromium ở cuối output.
            print(f"SYNC_ERROR: {error}")
            raise
    else:
        main()
