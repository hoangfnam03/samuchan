import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import samuchanLogo from './assets/samuchan-logo.png'

async function readApiJson(response) {
  const body = await response.text()

  try {
    return JSON.parse(body)
  } catch {
    const contentType = response.headers.get('content-type') || ''
    const receivedHtml = contentType.includes('text/html') || body.trimStart().startsWith('<')
    throw new Error(
      receivedHtml
        ? 'API trả về trang web thay vì dữ liệu. Hãy khởi động lại UI bằng npm run dev.'
        : 'API trả về dữ liệu không hợp lệ.'
    )
  }
}

const SKU_TRANSLATIONS = {
  '黑色无挂件': 'Đen - không kèm phụ kiện',
  '棕色无挂件': 'Nâu - không kèm phụ kiện',
  '咖色无挂件': 'Nâu cà phê - không kèm phụ kiện',
  '黑色': 'Màu đen', '白色': 'Màu trắng', '红色': 'Màu đỏ',
  '粉色': 'Màu hồng', '蓝色': 'Màu xanh dương', '绿色': 'Màu xanh lá',
  '黄色': 'Màu vàng', '紫色': 'Màu tím', '棕色': 'Màu nâu',
  '咖色': 'Màu nâu cà phê', '米色': 'Màu be', '灰色': 'Màu xám',
  '透明': 'Trong suốt', '无挂件': 'Không kèm phụ kiện', '有挂件': 'Có kèm phụ kiện',
  '小号': 'Size nhỏ', '中号': 'Size vừa', '大号': 'Size lớn',
}

function translateSku(sku) {
  if (!sku) return '-'
  const raw = String(sku).trim()
  if (SKU_TRANSLATIONS[raw]) return SKU_TRANSLATIONS[raw]
  let translated = raw
  Object.entries(SKU_TRANSLATIONS)
    .sort(([a], [b]) => b.length - a.length)
    .forEach(([zh, vi]) => { translated = translated.split(zh).join(vi) })
  return translated
}

const TUANVINH_CUTOFF = '2026-09-01'

const statusConfig = {
  'Đã giao': { label: 'Đã giao', className: 'delivered' },
  'Đang vận chuyển': { label: 'Đang vận chuyển', className: 'shipping' },
  'Chưa giao': { label: 'Chưa giao', className: 'pending' },
}

function statusClass(status) {
  const value = String(status || '').toLowerCase()
  if (value.includes('chưa giao') || value.includes('không tìm thấy')) return 'pending'
  if (value.includes('đã giao') || value.includes('giao hàng thành công')) return 'delivered'
  if (value.includes('nhập kho việt nam')) return 'vietnam-warehouse'
  if (value.includes('nhập kho trung quốc')) return 'china-warehouse'
  return 'shipping'
}

function StatusBadge({ status }) {
  const label = status || 'Chưa giao'
  return <span className={`status-badge ${statusClass(label)}`}>{label}</span>
}

function statusCategory(order) {
  if (dateKey(order.order_date) <= TUANVINH_CUTOFF) return 'Đã giao'
  if (!order.tracking_number) return 'Chưa giao'
  const tvStatus = order.tuanvinh?.current_status || order.status
  const value = String(tvStatus || '').toLowerCase()
  if (value.includes('đã giao') || value.includes('giao hàng thành công')) return 'Đã giao'
  return 'Đang vận chuyển'
}

function isAfterTuanVinhCutoff(order) {
  return dateKey(order.order_date) > TUANVINH_CUTOFF
}

function historyTime(history, keywords) {
  const list = Array.isArray(history) ? history : []
  const item = list.find((entry) => keywords.some((keyword) => String(entry.status || '').toLowerCase().includes(keyword)))
  return item?.time || null
}

function getTuanVinhDates(data) {
  const history = Array.isArray(data?.history) ? data.history : []
  return {
    chinaWarehouseAt: historyTime(history, ['nhập kho trung quốc']),
    vietnamWarehouseAt: historyTime(history, ['nhập kho việt nam']),
    vietnamExitAt: historyTime(history, ['xuất kho việt nam']),
  }
}

function shippingRatePerKg(weight) {
  const kg = Number(weight || 0)
  if (kg <= 0) return 0
  if (kg <= 5) return 22000
  if (kg <= 10) return 21000
  if (kg <= 81) return 20000
  return 20000
}

function calculateShippingCost(weight) {
  const kg = Number(weight || 0)
  return kg > 0 ? kg * shippingRatePerKg(kg) : 0
}

function ProductImage({ src, name, onClick, large = false }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <div className={`product-placeholder ${large ? 'large' : ''}`}>🛍️</div>
  return (
    <img
      className={`product-image ${large ? 'large' : ''}`}
      src={src}
      alt={name || 'Product'}
      onError={() => setFailed(true)}
      onClick={onClick}
    />
  )
}

function normalizeOrders(payload) {
  const orders = Array.isArray(payload?.orders) ? payload.orders : []
  return orders.map((order) => {
    const normalized = {
      ...order,
      order_id: order.order_id || order.orderId || '',
      shop_name: order.shop_name || order.shop || '',
      order_date: order.order_date || order.orderDate || '',
      order_total_cny: Number(order.order_total_cny ?? order.total ?? 0),
      status: order.status || (order.delivered_to_china_at ? 'Đã giao' : order.tracking_number ? 'Đang vận chuyển' : 'Chưa giao'),
      tracking_number: order.tracking_number || null,
      delivered_to_china_at: order.delivered_to_china_at || null,
      items: Array.isArray(order.items) ? order.items : [],
      tuanvinh: order.tuanvinh || null,
    }

    if (dateKey(normalized.order_date) <= TUANVINH_CUTOFF) {
      normalized.status = 'Đã giao'
    } else if (!normalized.tracking_number) {
      normalized.status = 'Chưa giao'
    }

    return normalized
  })
}

function dateKey(value) {
  if (!value) return 'Chưa xác định'
  const match = String(value).match(/(20\d{2}[-/]\d{1,2}[-/]\d{1,2})/)
  return match ? match[1].replaceAll('/', '-') : String(value).slice(0, 10)
}

function formatDate(value) {
  const key = dateKey(value)
  if (key === 'Chưa xác định') return key
  const parts = key.split('-')
  if (parts.length !== 3) return key
  return `${parts[2]}/${parts[1]}/${parts[0]}`
}

function OrderCard({ order, onClick, onImageClick, exchangeRate, formatVnd }) {
  const representative = order.items.find((item) => item.image) || order.items[0] || {}
  const totalQuantity = order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
  const shippingCost = calculateShippingCost(order.tuanvinh?.weight_kg)
  const category = statusCategory(order)

  return (
    <button className="order-card" type="button" onClick={() => onClick(order)}>
      <div className="order-card-image-wrap" onClick={(e) => { if (representative.image) { e.stopPropagation(); onImageClick(representative.image, representative.product_name) } }}>
        <ProductImage src={representative.image} name={representative.product_name} />
        {order.items.length > 1 && <span className="item-count">+{order.items.length - 1}</span>}
      </div>
      <div className="order-card-main">
        <div className="order-card-top">
          <div>
            <span className="order-label">ORDER ID</span>
            <strong>#{order.order_id || '-'}</strong>
          </div>
          <StatusBadge status={isAfterTuanVinhCutoff(order) && order.tuanvinh?.current_status ? order.tuanvinh.current_status : category} />
        </div>
        <div className="order-card-shop">{order.shop_name || 'Không xác định'}</div>
        <div className="order-card-bottom">
          <span>{totalQuantity} sản phẩm</span>
          <span>¥{Number(order.order_total_cny || 0).toFixed(2)}</span>
          {exchangeRate > 0 && <span className="order-vnd">{formatVnd(Number(order.order_total_cny || 0) * exchangeRate)}</span>}
          {shippingCost > 0 && <span className="order-shipping">VC {formatVnd(shippingCost)}</span>}
        </div>
      </div>
      <div className="order-card-arrow">›</div>
    </button>
  )
}

function OrderDetailModal({ order, onClose, onImageClick, exchangeRate, formatVnd, onTrackingSaved, onRefreshTuanVinh, skuMaster, skuLinks, onSkuLinkSaved }) {
  const totalQuantity = order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
  const [trackingInput, setTrackingInput] = useState(order.tracking_number || '')
  const [trackingSaving, setTrackingSaving] = useState(false)
  const [trackingEditing, setTrackingEditing] = useState(false)
  const [trackingMessage, setTrackingMessage] = useState('')
  const [liveTuanVinh, setLiveTuanVinh] = useState(order.tuanvinh || null)
  const [skuEditingKey, setSkuEditingKey] = useState(null)
  const [skuMessage, setSkuMessage] = useState('')

  useEffect(() => {
    setTrackingInput(order.tracking_number || '')
    setTrackingEditing(false)
    setTrackingMessage('')
    setLiveTuanVinh(order.tuanvinh || null)
    setSkuEditingKey(null)
    setSkuMessage('')
  }, [order.order_id, order.tracking_number, order.tuanvinh])

  const savePurchaseSku = (item, masterId) => {
    if (typeof onSkuLinkSaved === 'function') {
      onSkuLinkSaved(order, item, masterId)
      setSkuEditingKey(null)
      setSkuMessage('Đã lưu nhận diện SKU cho sản phẩm này.')
    }
  }


  const saveTracking = async () => {
    const tracking = trackingInput.trim()

    if (!tracking) {
      setTrackingMessage('Vui lòng nhập tracking number.')
      return
    }

    setTrackingSaving(true)
    setTrackingMessage('Đang lưu tracking và tra Tuấn Vĩnh...')

    try {
      const response = await fetch('/api/taobao/tracking', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          order_id: order.order_id,
          tracking_number: tracking,
        }),
      })

      const data = await readApiJson(response)

      if (!response.ok || data?.success === false) {
        throw new Error(
          data?.message ||
          data?.error ||
          'Không lưu được tracking'
        )
      }

      let savedOrder = {
        ...order,
        ...(data?.order || {}),
        tracking_number: tracking,
      }

      onTrackingSaved(savedOrder)

      setTrackingInput(tracking)
      setTrackingEditing(false)
      setLiveTuanVinh(savedOrder.tuanvinh || null)
      setTrackingMessage(
        'Đã lưu tracking. Bấm update Tuấn Vĩnh khi muốn lấy trạng thái mới nhất.'
      )

    } catch (err) {
      setTrackingMessage(
        `⚠️ ${err.message || 'Không lưu được tracking'}`
      )
    } finally {
      setTrackingSaving(false)
    }
  }

  const tv =
    liveTuanVinh ||
    order.tuanvinh ||
    null

  const tvDates = getTuanVinhDates(tv)

  const weight =
    Number(tv?.weight_kg || 0)
  const shippingCost = calculateShippingCost(weight)
  const displayStatus = isAfterTuanVinhCutoff(order) && tv?.current_status ? tv.current_status : statusCategory(order)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="order-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div><p className="eyebrow">ORDER DETAIL</p><h2>#{order.order_id}</h2></div>
          <button className="close-button" type="button" onClick={onClose}>×</button>
        </div>

        <div className="order-meta">
          <div><span>Shop</span><strong>{order.shop_name || '-'}</strong></div>
          <div><span>Ngày đặt</span><strong>{formatDate(order.order_date)}</strong></div>
          <div><span>Tổng sản phẩm</span><strong>{totalQuantity}</strong></div>
          <div><span>Tổng tiền</span><strong className="modal-total">¥{Number(order.order_total_cny || 0).toFixed(2)}</strong>{exchangeRate > 0 && <small className="modal-vnd-total">{formatVnd(Number(order.order_total_cny || 0) * exchangeRate)}</small>}</div>
        </div>

        <div className="modal-section-title">Sản phẩm trong đơn</div>
        <div className="modal-products">
          {order.items.map((item, index) => (
            <div className="modal-product modal-product-with-sku" key={`${item.sku}-${index}`}>
              <div className="modal-product-image" onClick={() => item.image && onImageClick(item.image, item.product_name)}>
                <ProductImage src={item.image} name={item.product_name} />
                {item.image && <span className="zoom-hint">⌕</span>}
              </div>
              <div className="modal-product-info">
                <strong>{item.product_name || '-'}</strong>
                <span className="sku translated-sku">{translateSku(item.sku)}</span>
                <small className="sku-original">SKU gốc: {item.sku || '-'}</small>
                <div className="modal-product-line">
                  <span>SL: <b>{item.quantity ?? 0}</b></span>
                  <span>¥{Number(item.unit_price_cny || 0).toFixed(2)} / sản phẩm</span>
                  <span className="item-subtotal">¥{(Number(item.unit_price_cny || 0) * Number(item.quantity || 0)).toFixed(2)}</span>
                  {exchangeRate > 0 && <span className="item-vnd">{formatVnd(Number(item.unit_price_cny || 0) * Number(item.quantity || 0))}</span>}
                </div>
                {(() => {
                  const key = purchaseItemKey(order, item)
                  const manualSku = skuLinks?.[key] || ''
                  const autoSku = getAutoMatchedSku(item, skuMaster || [])
                  const currentSku = manualSku || autoSku?.id || ''
                  const isEditing = skuEditingKey === key

                  return (
                    <div className="purchase-sku-recognition">
                      <div className="purchase-sku-recognition-heading">
                        <span>SKU phân loại</span>
                        {manualSku ? (
                          <small className="sku-mapping-manual">Đã gán tay</small>
                        ) : autoSku ? (
                          <small className="sku-mapping-auto">Tự nhận diện từ alias</small>
                        ) : (
                          <small className="sku-mapping-none">Chưa nhận diện</small>
                        )}
                      </div>

                      {(!autoSku || isEditing || manualSku) ? (
                        <div className="purchase-sku-recognition-controls">
                          <select
                            value={currentSku}
                            onChange={(event) => savePurchaseSku(item, event.target.value)}
                            aria-label="Gán SKU cho sản phẩm"
                          >
                            <option value="">— Chưa phân loại —</option>
                            {(skuMaster || []).map((master) => (
                              <option key={master.id} value={master.id}>
                                {master.id} — {master.name}
                              </option>
                            ))}
                          </select>
                          {isEditing && autoSku && !manualSku && (
                            <button type="button" className="tracking-cancel-button" onClick={() => setSkuEditingKey(null)}>
                              Hủy
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="purchase-sku-recognition-current">
                          <strong>{autoSku.id} — {autoSku.name}</strong>
                          <button type="button" className="sku-recognition-edit" onClick={() => setSkuEditingKey(key)}>
                            Sửa nhận diện
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            </div>
          ))}
        </div>
        {skuMessage && <div className="sku-recognition-message">✓ {skuMessage}</div>}

        <div className="logistics-box">
          <div className="logistics-status">
            <span>Trạng thái</span>
            <StatusBadge status={displayStatus} />
          </div>

          <div className="tracking-panel">
            <div className="tracking-panel-title">
              <span>Tracking number</span>
              {order.tracking_number && !trackingEditing && (
                <div className="tracking-actions">
                  <button
                    type="button"
                    className="tracking-edit-button"
                    onClick={() => setTrackingEditing(true)}
                  >
                    ✎ Edit
                  </button>

                  <button
                    type="button"
                    className="tracking-refresh-button"
                    aria-label="Cập nhật dữ liệu Tuấn Vĩnh"
                    title="Cập nhật dữ liệu Tuấn Vĩnh"
                    disabled={trackingSaving}
                    onClick={async () => {
                      setTrackingSaving(true)
                      setTrackingMessage(
                        'Đang tra lại dữ liệu Tuấn Vĩnh...'
                      )

                      try {
                        const refreshedTv =
                          await onRefreshTuanVinh({
                            ...order,
                            tracking_number:
                              String(
                                order.tracking_number || ''
                              ).trim(),
                            forceTuanVinh: true,
                          })

                        if (refreshedTv?.success) {
                          setLiveTuanVinh(refreshedTv)
                          setTrackingMessage(
                            '✓ Đã cập nhật dữ liệu Tuấn Vĩnh.'
                          )
                        } else {
                          setTrackingMessage(
                            '⚠️ Tuấn Vĩnh chưa trả dữ liệu cho mã này.'
                          )
                        }
                      } catch (refreshError) {
                        setTrackingMessage(
                          `⚠️ ${refreshError.message || 'Không tra được Tuấn Vĩnh'}`
                        )
                      } finally {
                        setTrackingSaving(false)
                      }
                    }}
                  >
                    ↻
                  </button>
                </div>
              )}
            </div>

            {trackingEditing || !order.tracking_number ? (
              <div className="manual-tracking">
                <div className="manual-tracking-row">
                  <input
                    autoFocus={trackingEditing}
                    value={trackingInput}
                    onChange={(e) => setTrackingInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveTracking()
                      if (e.key === 'Escape' && trackingEditing) {
                        setTrackingInput(order.tracking_number || '')
                        setTrackingEditing(false)
                      }
                    }}
                    placeholder="Nhập tracking number đúng..."
                    aria-label="Tracking number"
                  />
                  <button type="button" onClick={saveTracking} disabled={trackingSaving}>
                    {trackingSaving ? 'Đang lưu...' : 'Lưu'}
                  </button>
                  {trackingEditing && (
                    <button
                      type="button"
                      className="tracking-cancel-button"
                      onClick={() => {
                        setTrackingInput(order.tracking_number || '')
                        setTrackingEditing(false)
                        setTrackingMessage('')
                      }}
                      disabled={trackingSaving}
                    >
                      Hủy
                    </button>
                  )}
                </div>
                <small>
                  {order.tracking_number
                    ? 'Nếu tracking Taobao lấy sai, nhập số đúng rồi Lưu. Tracking mới sẽ được ưu tiên giữ nguyên ở các lần chạy sau.'
                    : 'Chưa có tracking từ Taobao? Bạn có thể nhập tracking của kiện hàng tại đây.'}
                </small>
                {trackingMessage && <em className={trackingMessage.startsWith('⚠️') ? 'tracking-error' : 'tracking-success'}>{trackingMessage}</em>}
              </div>
            ) : (
              <div className="tracking-current-row">
                <strong className="tracking-value">
                  {order.tracking_number}
                  {order.tracking_source === 'manual' ? ' (đã sửa tay)' : ''}
                </strong>
              </div>
            )}
          </div>

          <div className="logistics-timeline">
            <div><span>Ngày nhập kho Trung</span><strong>{tvDates.chinaWarehouseAt || 'Chưa có dữ liệu'}</strong></div>
            <div><span>Ngày về Việt Nam</span><strong>{tvDates.vietnamWarehouseAt || 'Chưa có dữ liệu'}</strong></div>
            <div><span>Ngày xuất kho</span><strong>{tvDates.vietnamExitAt || 'Chưa có dữ liệu'}</strong></div>
            <div><span>Cân nặng order</span><strong>{weight > 0 ? `${weight.toFixed(2)} kg` : 'Chưa có dữ liệu'}</strong></div>
            <div><span>Phí vận chuyển</span><strong className="shipping-cost">{shippingCost > 0 ? formatVnd(shippingCost) : 'Chưa có dữ liệu'}</strong></div>
            {tv?.fetched_at && <div><span>Cập nhật Tuấn Vĩnh</span><strong>{formatTimeValue(tv.fetched_at)}</strong></div>}
          </div>
        </div>

        {isAfterTuanVinhCutoff(order) && !order.tracking_number && (
          <div className="logistics-note">Đơn sau 01/09/2026 chưa có tracking nên chưa thể tra cứu Tuấn Vĩnh.</div>
        )}
        {isAfterTuanVinhCutoff(order) && order.tracking_number && !tv && (
          <div className="logistics-note">Đang chờ dữ liệu Tuấn Vĩnh cho tracking này.</div>
        )}
        {order.logistics_note && <div className="logistics-note">ℹ️ {order.logistics_note}</div>}
      </div>
    </div>
  )
}

function formatTimeValue(value) {
  if (!value) return '-'
  const normalized = String(value).replace('T', ' ').replace('Z', '')
  return normalized.slice(0, 19)
}
// ============================================================
// SKU MASTER
// ============================================================

// ============================================================
// SKU STORAGE
// ============================================================

// Railway API
const SKU_API_BASE = '/api/sku'
const SHOP_API_BASE = '/api/shop'
const SETTINGS_API_BASE = '/api/settings'
const SHOP_NAMES = ['SAMU.SHOP', 'DJK BAT', 'NOMORI HOME']
const DEFAULT_SHOP_NAME = SHOP_NAMES[0]

function normalizeShopName(value) {
  const name = String(value || '').trim().toUpperCase()
  return SHOP_NAMES.find((shopName) => shopName.toUpperCase() === name) || DEFAULT_SHOP_NAME
}

// ============================================================
// Railway API
// ============================================================

async function fetchAppSettings() {
  const response = await fetch(SETTINGS_API_BASE, { cache: 'no-store' })
  const result = await readApiJson(response)

  if (!response.ok || !result?.success || !result.settings || typeof result.settings !== 'object') {
    throw new Error(result?.message || 'Khong doc duoc cai dat tu Railway')
  }

  return result.settings
}

async function saveAppSettings(settings) {
  const response = await fetch(SETTINGS_API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
  const result = await readApiJson(response)

  if (!response.ok || !result?.success) {
    throw new Error(result?.message || 'Khong luu duoc cai dat len Railway')
  }

  return result.settings
}

async function fetchSkuMaster() {
  try {
    const response = await fetch(
      `${SKU_API_BASE}/master`
    )

    if (!response.ok) {
      throw new Error(
        `SKU Master HTTP ${response.status}`
      )
    }

    const result =
      await response.json()

    if (
      result?.success &&
      Array.isArray(result.skus)
    ) {
      return result.skus
    }

    throw new Error(
      'SKU Master response không hợp lệ'
    )
  } catch (error) {
    console.error(
      '[SKU MASTER LOAD]',
      error
    )

    return null
  }
}

async function fetchSkuLinks() {
  try {
    const response = await fetch(
      `${SKU_API_BASE}/links`
    )

    if (!response.ok) {
      throw new Error(
        `SKU Links HTTP ${response.status}`
      )
    }

    const result =
      await response.json()

    if (
      result?.success &&
      result.links &&
      typeof result.links === 'object'
    ) {
      return result.links
    }

    throw new Error(
      'SKU Links response không hợp lệ'
    )
  } catch (error) {
    console.error(
      '[SKU LINKS LOAD]',
      error
    )

    return null
  }
}

async function saveSkuMaster(data) {
  // luôn lưu local trước để có backup
  try {
    const response = await fetch(
      `${SKU_API_BASE}/master`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          skus: data
        })
      }
    )

    if (!response.ok) {
      throw new Error(
        `SKU Master HTTP ${response.status}`
      )
    }

    const result =
      await response.json()

    if (!result?.success) {
      throw new Error(
        result?.message ||
        'Không lưu được SKU Master'
      )
    }

    console.log(
      '[SKU MASTER] Saved to Railway'
    )

    return true
  } catch (error) {
    console.error(
      '[SKU MASTER SAVE]',
      error
    )

    return false
  }
}

async function saveSkuLinks(data) {
  // luôn lưu local trước để có backup
  try {
    const response = await fetch(
      `${SKU_API_BASE}/links`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          links: data
        })
      }
    )

    if (!response.ok) {
      throw new Error(
        `SKU Links HTTP ${response.status}`
      )
    }

    const result =
      await response.json()

    if (!result?.success) {
      throw new Error(
        result?.message ||
        'Không lưu được SKU Links'
      )
    }

    console.log(
      '[SKU LINKS] Saved to Railway'
    )

    return true
  } catch (error) {
    console.error(
      '[SKU LINKS SAVE]',
      error
    )

    return false
  }
}

async function fetchShopSales() {
  const response = await fetch(`${SHOP_API_BASE}/sales`, { cache: 'no-store' })
  const result = await readApiJson(response)

  if (!response.ok || !result?.success || !Array.isArray(result.sales)) {
    throw new Error(result?.message || 'Khong doc duoc don SAMU.SHOP')
  }

  return result.sales
}

async function saveShopSales(data) {
  const normalizedSales = normalizeShopSales(data)
  const response = await fetch(`${SHOP_API_BASE}/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sales: normalizedSales }),
  })
  const result = await readApiJson(response)

  if (!response.ok || !result?.success) {
    throw new Error(result?.message || 'Khong luu duoc don SAMU.SHOP')
  }

  return normalizeShopSales(result.sales)
}

function localDateValue(value) {
  const match = String(value || '').match(/^(20\d{2}-\d{2}-\d{2})/)
  return match ? match[1] : ''
}

function todayInputValue() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function normalizeShopSales(data) {
  return (Array.isArray(data) ? data : []).map((sale) => ({
    ...sale,
    shopName: normalizeShopName(sale.shopName || sale.shop_name || sale.shop),
    orderDate: localDateValue(sale.orderDate) || localDateValue(sale.date),
    completedDate: localDateValue(sale.completedDate),
  }))
}
function purchaseItemKey(order, item) {
  return [
    String(order?.order_id || '').trim(),
    String(item?.sku || '').trim(),
    String(item?.product_name || '').trim(),
  ].join('::')
}

function getAutoMatchedSku(item, skuMaster) {
  const rawSku = String(item?.sku || '').trim()
  if (!rawSku) return null

  return skuMaster.find((master) =>
    Array.isArray(master.taobao_skus) &&
    master.taobao_skus.some(
      (x) => String(x || '').trim() === rawSku
    )
  ) || null
}
function SkuMasterPage({
  skuMaster,
  setSkuMaster,
  orders,
  skuLinks,
  setSkuLinks,
  exchangeRate,
  formatVnd,
  selectedYear,
  selectedMonth,
  selectedDay,
  availableYears,
  availableMonths,
  availableDays,
  onYearChange,
  onMonthChange,
  onDayChange,
  onRefreshPurchases,
}) {
  const [editing, setEditing] = useState(null)
  const [skuId, setSkuId] = useState('')
  const [skuName, setSkuName] = useState('')
  const [skuImage, setSkuImage] = useState('')
  const [taobaoSkus, setTaobaoSkus] = useState('')
  const [notes, setNotes] = useState('')
  const [search, setSearch] = useState('')
  const [purchaseRefreshing, setPurchaseRefreshing] = useState(false)

  const resetForm = () => {
    setEditing(null)
    setSkuId('')
    setSkuName('')
    setSkuImage('')
    setTaobaoSkus('')
    setNotes('')
  }

  const startEdit = (sku) => {
    setEditing(sku.id)
    setSkuId(sku.id)
    setSkuName(sku.name || '')
    setSkuImage(sku.image || '')
    setTaobaoSkus(
      Array.isArray(sku.taobao_skus)
        ? sku.taobao_skus.join('\n')
        : ''
    )
    setNotes(sku.notes || '')

    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    })
  }

  const handleImage = (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()

    reader.onload = () => {
      setSkuImage(String(reader.result || ''))
    }

    reader.readAsDataURL(file)
  }

  const saveSku = () => {
    const id = skuId.trim()
    const name = skuName.trim()

    if (!id) {
      alert('Vui lòng nhập SKU ID.')
      return
    }

    if (!name) {
      alert('Vui lòng nhập tên SKU.')
      return
    }

    const aliases = taobaoSkus
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)

    const now = new Date().toISOString()

    const record = {
      id,
      name,
      image: skuImage || '',
      taobao_skus: [...new Set(aliases)],
      notes: notes.trim(),
      created_at:
        editing
          ? (
              skuMaster.find((x) => x.id === editing)?.created_at ||
              now
            )
          : now,
      updated_at: now,
    }

    const duplicate = skuMaster.some(
      (x) => x.id === id && x.id !== editing
    )

    if (duplicate) {
      alert(`SKU ID "${id}" đã tồn tại.`)
      return
    }

    let next

    if (editing) {
      next = skuMaster.map((x) =>
        x.id === editing ? record : x
      )
    } else {
      next = [...skuMaster, record]
    }

    next.sort((a, b) =>
      String(a.id).localeCompare(String(b.id))
    )

    setSkuMaster(next)
    saveSkuMaster(next)

    resetForm()
  }

  const deleteSku = (id) => {
    const sku = skuMaster.find((x) => x.id === id)

    if (!sku) return

    const confirmed = window.confirm(
      `Xóa SKU ${id} - ${sku.name}?`
    )

    if (!confirmed) return

    const next = skuMaster.filter((x) => x.id !== id)

    setSkuMaster(next)
    saveSkuMaster(next)
  }

  const filtered = skuMaster.filter((sku) => {
    const keyword = search.trim().toLowerCase()

    if (!keyword) return true

    return [
      sku.id,
      sku.name,
      ...(sku.taobao_skus || []),
      sku.notes,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(keyword)
  })

  const getPurchaseStats = (masterId) => {
    let quantity = 0
    let totalCny = 0
    let totalShipping = 0
    let itemCount = 0

    orders.forEach((order) => {
      order.items.forEach((item) => {
        const key = purchaseItemKey(order, item)

        const linkedId =
          skuLinks[key] ||
          getAutoMatchedSku(item, skuMaster)?.id

        if (linkedId !== masterId) return

        const qty = Number(item.quantity || 0)
        const price = Number(item.unit_price_cny || 0)

        quantity += qty
        totalCny += qty * price
        const orderValue = order.items.reduce((sum, current) => sum + Number(current.quantity || 0) * Number(current.unit_price_cny || 0), 0)
        if (orderValue > 0) totalShipping += calculateShippingCost(order.tuanvinh?.weight_kg) * ((qty * price) / orderValue)
        itemCount += 1
      })
    })

    return {
      quantity,
      totalCny,
      totalVnd: totalCny * Number(exchangeRate || 0),
      totalShipping,
      averageVnd: quantity > 0 ? (totalCny / quantity) * Number(exchangeRate || 0) : 0,
      averageShipping: quantity > 0 ? totalShipping / quantity : 0,
      itemCount,
      averageCost:
        quantity > 0
          ? totalCny / quantity
          : 0,
    }
  }

  const assignPurchaseItem = (order, item, masterId) => {
    const key = purchaseItemKey(order, item)

    const next = {
      ...skuLinks,
    }

    if (!masterId) {
      delete next[key]
    } else {
      next[key] = masterId
    }

    setSkuLinks(next)
    saveSkuLinks(next)
  }

  const refreshPurchaseSkuList = async () => {
    if (!onRefreshPurchases || purchaseRefreshing) return

    setPurchaseRefreshing(true)

    try {
      await onRefreshPurchases()
    } finally {
      setPurchaseRefreshing(false)
    }
  }

  return (
    <main className="dashboard">
      <section className="page-heading">
        <div>
          <p className="eyebrow">SKU MASTER</p>

          <h1>SKU Master</h1>

          <p className="heading-description">
            Quản lý SKU chuẩn của SAMUCHAN và liên kết với SKU Taobao.
          </p>
        </div>

        <div className="last-sync">
          <span className="online-dot" />
          {skuMaster.length} SKU
        </div>
      </section>

      {/* ================================================== */}
      {/* FORM */}
      {/* ================================================== */}

      <section className="sku-master-form">
        <div className="sku-form-header">
          <div>
            <p className="eyebrow">
              {editing ? 'EDIT SKU' : 'NEW SKU'}
            </p>

            <h2>
              {editing
                ? `Chỉnh sửa ${editing}`
                : 'Tạo SKU mới'}
            </h2>
          </div>

          {editing && (
            <button
              type="button"
              className="tracking-cancel-button"
              onClick={resetForm}
            >
              Hủy sửa
            </button>
          )}
        </div>

        <div className="sku-form-grid">

          <div className="sku-image-editor">

            <div className="sku-image-preview">
              {skuImage ? (
                <img
                  src={skuImage}
                  alt={skuName || 'SKU'}
                />
              ) : (
                <span>🖼️</span>
              )}
            </div>

            <label className="sku-upload-button">
              Chọn ảnh sản phẩm

              <input
                type="file"
                accept="image/*"
                onChange={handleImage}
                hidden
              />
            </label>
          </div>

          <div className="sku-form-fields">

            <label>
              <span>SKU ID *</span>

              <input
                value={skuId}
                onChange={(e) =>
                  setSkuId(e.target.value.toUpperCase())
                }
                disabled={Boolean(editing)}
                placeholder="VD: SAM-001"
              />
            </label>

            <label>
              <span>Tên SKU *</span>

              <input
                value={skuName}
                onChange={(e) =>
                  setSkuName(e.target.value)
                }
                placeholder="VD: Túi nâu mini"
              />
            </label>

            <label>
              <span>SKU Taobao tương ứng</span>

              <textarea
                value={taobaoSkus}
                onChange={(e) =>
                  setTaobaoSkus(e.target.value)
                }
                placeholder={`Mỗi SKU một dòng

VD:
棕色无挂件
棕色`}
                rows={4}
              />

              <small>
                Purchase sẽ tự nhận diện nếu SKU Taobao
                trùng chính xác một trong các dòng này.
              </small>
            </label>

            <label>
              <span>Ghi chú</span>

              <textarea
                value={notes}
                onChange={(e) =>
                  setNotes(e.target.value)
                }
                placeholder="Ghi chú sản phẩm..."
                rows={2}
              />
            </label>

            <button
              type="button"
              className="sku-save-button"
              onClick={saveSku}
            >
              {editing
                ? '✓ Lưu thay đổi'
                : '+ Tạo SKU'}
            </button>
          </div>
        </div>
      </section>

      {/* ================================================== */}
      {/* SKU LIST */}
      {/* ================================================== */}

      <section className="orders-card sku-master-card">

        <div className="toolbar">

          <div className="search-box">
            <span>⌕</span>

            <input
              value={search}
              onChange={(e) =>
                setSearch(e.target.value)
              }
              placeholder="Tìm SKU ID, tên, SKU Taobao..."
            />

            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
              >
                ×
              </button>
            )}
          </div>

          <div className="sku-count">
            {filtered.length} SKU
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state">
            Chưa có SKU Master.
          </div>
        ) : (
          <div className="sku-master-list">

            {filtered.map((sku) => {

              const stats =
                getPurchaseStats(sku.id)

              return (
                <div
                  className="sku-master-row"
                  key={sku.id}
                >

                  <div className="sku-master-image">
                    {sku.image ? (
                      <img
                        src={sku.image}
                        alt={sku.name}
                      />
                    ) : (
                      <span>🛍️</span>
                    )}
                  </div>

                  <div className="sku-master-main">

                    <div className="sku-master-title">
                      <strong>{sku.id}</strong>

                      <span>
                        {sku.name}
                      </span>
                    </div>

                    <div className="sku-master-alias">
                      {sku.taobao_skus?.length
                        ? sku.taobao_skus.map((x) => (
                            <span key={x}>
                              {x}
                            </span>
                          ))
                        : (
                            <small>
                              Chưa khai báo SKU Taobao
                            </small>
                          )}
                    </div>

                    <div className="sku-master-stats">

                      <div>
                        <small>Đã mua</small>
                        <strong>
                          {stats.quantity}
                        </strong>
                      </div>

                      <div>
                        <small>Số dòng Purchase</small>
                        <strong>
                          {stats.itemCount}
                        </strong>
                      </div>

                      <div>
                        <small>Tổng tiền</small>
                        <strong>
                          ¥{stats.totalCny.toFixed(2)}
                        </strong>
                      </div>

                      <div>
                        <small>Giá vốn TB</small>
                        <strong>
                          ¥{stats.averageCost.toFixed(2)}
                        </strong>
                      </div>

                      <div>
                        <small>Tiền Việt Nam</small>
                        <strong className="sku-vnd">{exchangeRate > 0 ? formatVnd(stats.totalVnd) : 'Nhập tỷ giá'}</strong>
                        <small>{exchangeRate > 0 ? `${formatVnd(stats.averageVnd)} / cái` : ''}</small>
                      </div>
                      <div>
                        <small>Phí vận chuyển</small>
                        <strong className="sku-vnd">{stats.totalShipping > 0 ? formatVnd(stats.totalShipping) : '—'}</strong>
                        <small>{stats.totalShipping > 0 ? `${formatVnd(stats.averageShipping)} / cái` : ''}</small>
                      </div>

                    </div>

                  </div>

                  <div className="sku-master-actions">

                    <button
                      type="button"
                      onClick={() => startEdit(sku)}
                    >
                      ✎ Sửa
                    </button>

                    <button
                      type="button"
                      className="sku-delete-button"
                      onClick={() => deleteSku(sku.id)}
                    >
                      × Xóa
                    </button>

                  </div>

                </div>
              )
            })}

          </div>
        )}
      </section>

      {/* ================================================== */}
      {/* PURCHASE MAPPING */}
      {/* ================================================== */}

      {false && (
      <section className="orders-card sku-purchase-map-card">

        <div className="sku-section-heading">
          <div>
            <p className="eyebrow">
              PURCHASE → SKU
            </p>

            <h2>
              Phân loại sản phẩm đã mua
            </h2>

            <p>
              SKU Taobao trùng alias sẽ tự nhận diện.
              Nếu chưa đúng, bạn có thể gán SKU thủ công.
            </p>
          </div>
          <div className="sku-date-filters">
            <button
              type="button"
              className="sku-refresh-button"
              onClick={refreshPurchaseSkuList}
              disabled={purchaseRefreshing}
            >
              <span>↻</span>
              {purchaseRefreshing ? 'Đang cập nhật...' : 'Cập nhật'}
            </button>
            <select value={selectedYear} onChange={(e) => onYearChange(e.target.value)}><option value="Tất cả">Tất cả năm</option>{availableYears.map((year) => <option key={year} value={year}>{year}</option>)}</select>
            <select value={selectedMonth} onChange={(e) => onMonthChange(e.target.value)}><option value="Tất cả">Tất cả tháng</option>{availableMonths.map((month) => <option key={month} value={month}>Tháng {Number(month)}</option>)}</select>
            <select value={selectedDay} onChange={(e) => onDayChange(e.target.value)}><option value="Tất cả">Tất cả ngày</option>{availableDays.map((day) => <option key={day} value={day}>Ngày {Number(day)}</option>)}</select>
          </div>
        </div>

        {orders.length === 0 ? (
          <div className="empty-state">
            Chưa có dữ liệu Purchase.
          </div>
        ) : (
          <div className="purchase-sku-list">

            {orders.flatMap((order) =>
              order.items.map((item) => {

                const key =
                  purchaseItemKey(order, item)

                const manualSku =
                  skuLinks[key] || ''

                const autoSku =
                  getAutoMatchedSku(
                    item,
                    skuMaster
                  )

                const currentSku =
                  manualSku || autoSku?.id || ''

                return (
                  <div
                    className="purchase-sku-row"
                    key={key}
                  >

                    <div className="purchase-sku-image">

                      {item.image ? (
                        <img
                          src={item.image}
                          alt={item.product_name}
                        />
                      ) : (
                        <span>🛍️</span>
                      )}

                    </div>

                    <div className="purchase-sku-product">

                      <strong>
                        {item.product_name || '-'}
                      </strong>

                      <span>
                        SKU Taobao:{' '}
                        {item.sku || '-'}
                      </span>

                      <small>
                        Order #{order.order_id}
                      </small>

                    </div>

                    <div className="purchase-sku-numbers">

                      <span>
                        SL:{' '}
                        <b>
                          {item.quantity || 0}
                        </b>
                      </span>

                      <span>
                        ¥
                        {Number(
                          item.unit_price_cny || 0
                        ).toFixed(2)}
                      </span>

                    </div>

                    <div className="purchase-sku-assignment">

                      <select
                        value={currentSku}
                        onChange={(e) =>
                          assignPurchaseItem(
                            order,
                            item,
                            e.target.value
                          )
                        }
                      >
                        <option value="">
                          — Chưa phân loại —
                        </option>

                        {skuMaster.map((master) => (
                          <option
                            key={master.id}
                            value={master.id}
                          >
                            {master.id} — {master.name}
                          </option>
                        ))}

                      </select>

                      {manualSku ? (
                        <small className="sku-mapping-manual">
                          ✓ Gán thủ công
                        </small>
                      ) : autoSku ? (
                        <small className="sku-mapping-auto">
                          ✓ Tự nhận diện
                        </small>
                      ) : (
                        <small className="sku-mapping-none">
                          Chưa nhận diện
                        </small>
                      )}

                    </div>

                  </div>
                )
              })
            )}

          </div>
        )}

      </section>
      )}
    </main>
  )
}

function ShopPage({ shopName = DEFAULT_SHOP_NAME, skuMaster, orders, exchangeRate, formatVnd, sales, onSalesChange, skuLinks, salesLoading, salesError }) {
  const [editingSale, setEditingSale] = useState(null)
  const [saving, setSaving] = useState(false)
  const [selectedYear, setSelectedYear] = useState('all')
  const [selectedMonth, setSelectedMonth] = useState('all')
  const [selectedDay, setSelectedDay] = useState('all')
  const [selectedChartMonth, setSelectedChartMonth] = useState(null)
  const [form, setForm] = useState({ sku: '', quantity: 1, revenue: '', shipping: '', purchaseOrderId: '', orderDate: todayInputValue(), completedDate: '' })

  const resetForm = () => {
    setEditingSale(null)
    setForm({ sku: '', quantity: 1, revenue: '', shipping: '', purchaseOrderId: '', orderDate: todayInputValue(), completedDate: '' })
  }

  const getSaleDetails = (sale) => {
    const quantity = Number(sale.quantity || 0)
    const selectedOrder = orders.find((order) => String(order.order_id) === String(sale.purchaseOrderId))
    const sourceOrders = selectedOrder ? [selectedOrder] : orders
    const matchingByOrder = sourceOrders.map((order) => {
      const items = order.items.filter((item) => {
        const linked = skuLinks?.[purchaseItemKey(order, item)] || getAutoMatchedSku(item, skuMaster)?.id
        return linked === sale.sku
      })
      const quantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
      const cny = items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_price_cny || 0), 0)
      const allQuantity = order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
      return { order, quantity, cny, allQuantity }
    }).filter((source) => source.quantity > 0)

    const sourceQuantity = matchingByOrder.reduce((sum, source) => sum + source.quantity, 0)
    const sourceCny = matchingByOrder.reduce((sum, source) => sum + source.cny, 0)
    const unitCny = sourceQuantity > 0 ? sourceCny / sourceQuantity : 0
    const originalCny = unitCny * quantity
    const originalVnd = originalCny * Number(exchangeRate || 0)

    let purchaseShipping = 0
    let weight = 0
    if (selectedOrder) {
      const allQuantity = selectedOrder.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
      purchaseShipping = calculateShippingCost(selectedOrder.tuanvinh?.weight_kg) * quantity / Math.max(1, allQuantity)
      weight = Number(selectedOrder.tuanvinh?.weight_kg || 0)
    } else if (sourceQuantity > 0) {
      const shippingTotal = matchingByOrder.reduce((sum, source) => (
        sum + calculateShippingCost(source.order.tuanvinh?.weight_kg) * source.quantity / Math.max(1, source.allQuantity)
      ), 0)
      purchaseShipping = shippingTotal * quantity / sourceQuantity
    }

    const vietnamShipping = Number(sale.shipping || 0)
    const totalCost = originalVnd + purchaseShipping + vietnamShipping
    const revenue = Number(sale.revenue || 0)
    return {
      quantity,
      revenue,
      originalCny,
      originalVnd,
      purchaseShipping,
      weight,
      vietnamShipping,
      totalCost,
      profit: revenue - totalCost,
    }
  }

  const addSale = async () => {
    const quantity = Number(form.quantity || 0)
    const revenue = Number(form.revenue || 0)
    if (!form.sku || quantity <= 0 || revenue < 0 || !form.orderDate) return

    const record = {
      id: editingSale || Date.now(),
      ...form,
      shopName,
      quantity,
      revenue,
      shipping: Number(form.shipping || 0),
      date: new Date().toISOString(),
    }
    const next = editingSale
      ? sales.map((sale) => sale.id === editingSale ? record : sale)
      : [...sales, record]

    setSaving(true)
    try {
      const saved = await onSalesChange(next)
      if (saved) resetForm()
    } finally {
      setSaving(false)
    }
  }

  const editSale = (sale) => {
    setForm({
      sku: sale.sku || '',
      quantity: sale.quantity || 1,
      revenue: sale.revenue ?? '',
      shipping: sale.shipping ?? '',
      purchaseOrderId: sale.purchaseOrderId || '',
      orderDate: sale.orderDate || localDateValue(sale.date) || todayInputValue(),
      completedDate: sale.completedDate || '',
    })
    setEditingSale(sale.id)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const deleteSale = async (sale) => {
    const confirmed = window.confirm(`Xóa đơn bán ${sale.sku || ''} ngày ${sale.orderDate || localDateValue(sale.date) || 'chưa rõ'}?`)
    if (!confirmed || saving) return

    setSaving(true)
    try {
      const saved = await onSalesChange(sales.filter((item) => item.id !== sale.id))
      if (saved && editingSale === sale.id) resetForm()
    } finally {
      setSaving(false)
    }
  }

  const saleDate = (sale) => localDateValue(sale.orderDate || sale.date)
  const availableYears = [...new Set(sales.map((sale) => saleDate(sale).slice(0, 4)).filter(Boolean))].sort((a, b) => b.localeCompare(a))
  const availableMonths = [...new Set(sales.map((sale) => saleDate(sale)).filter((date) => date && (selectedYear === 'all' || date.startsWith(`${selectedYear}-`))).map((date) => date.slice(5, 7)))].sort((a, b) => Number(a) - Number(b))
  const availableDays = [...new Set(sales.map((sale) => saleDate(sale)).filter((date) => date && (selectedYear === 'all' || date.startsWith(`${selectedYear}-`)) && (selectedMonth === 'all' || date.slice(5, 7) === selectedMonth)).map((date) => date.slice(8, 10)))].sort((a, b) => Number(a) - Number(b))
  const filteredSales = sales.filter((sale) => {
    const date = saleDate(sale)
    return (selectedYear === 'all' || date.startsWith(`${selectedYear}-`))
      && (selectedMonth === 'all' || date.slice(5, 7) === selectedMonth)
      && (selectedDay === 'all' || date.slice(8, 10) === selectedDay)
  })

  const monthlyMap = new Map()
  filteredSales.forEach((sale) => {
    const key = saleDate(sale).slice(0, 7) || 'unknown'
    if (!monthlyMap.has(key)) monthlyMap.set(key, { key, revenue: 0, cost: 0, profit: 0 })
    const month = monthlyMap.get(key)
    const details = getSaleDetails(sale)
    month.revenue += details.revenue
    month.cost += details.totalCost
    month.profit += details.profit
  })
  const monthlyRows = [...monthlyMap.values()].sort((a, b) => b.key.localeCompare(a.key))
  const chartMax = Math.max(1, ...monthlyRows.flatMap((row) => [row.revenue, row.cost, row.profit]))
  const selectedChart = monthlyRows.find((row) => row.key === selectedChartMonth) || null
  const totalRevenue = filteredSales.reduce((sum, sale) => sum + getSaleDetails(sale).revenue, 0)
  const totalCost = filteredSales.reduce((sum, sale) => sum + getSaleDetails(sale).totalCost, 0)
  const totalProfit = totalRevenue - totalCost

  return <main className="dashboard">
    <section className="page-heading"><div><p className="eyebrow">{shopName}</p><h1>Doanh thu & lợi nhuận</h1><p className="heading-description">Theo dõi doanh số của {shopName}, có ngày ra đơn, ngày hoàn thành và đầy đủ giá vốn.</p></div></section>
    {salesError && <div className="error-box">⚠️ {salesError}</div>}

    <section className="orders-card shop-entry-card">
      <h2>{editingSale ? 'Sửa đơn bán' : 'Thêm đơn bán'}</h2>
      <div className="shop-entry-grid">
        <label className="shop-form-field"><span>SKU</span><select disabled={salesLoading || saving} value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })}><option value="">Chọn SKU</option>{skuMaster.map((sku) => <option key={sku.id} value={sku.id}>{sku.id} — {sku.name}</option>)}</select></label>
        <label className="shop-form-field"><span>Số lượng</span><input disabled={salesLoading || saving} type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} /></label>
        <label className="shop-form-field"><span>Doanh thu (₫)</span><input disabled={salesLoading || saving} type="number" min="0" value={form.revenue} onChange={(e) => setForm({ ...form, revenue: e.target.value })} /></label>
        <label className="shop-form-field"><span>Phí VC Việt Nam (₫)</span><input disabled={salesLoading || saving} type="number" min="0" value={form.shipping} onChange={(e) => setForm({ ...form, shipping: e.target.value })} /></label>
        <label className="shop-form-field"><span>Ngày ra đơn</span><input disabled={salesLoading || saving} type="date" value={form.orderDate} onChange={(e) => setForm({ ...form, orderDate: e.target.value })} /></label>
        <label className="shop-form-field"><span>Ngày hoàn thành</span><input disabled={salesLoading || saving} type="date" value={form.completedDate} onChange={(e) => setForm({ ...form, completedDate: e.target.value })} /></label>
        <div className="shop-form-actions"><button type="button" onClick={addSale} disabled={salesLoading || saving}>{salesLoading ? 'Đang tải...' : saving ? 'Đang lưu...' : editingSale ? 'Lưu sửa' : '+ Thêm đơn'}</button>{editingSale && <button type="button" className="tracking-cancel-button" onClick={resetForm} disabled={saving}>Hủy</button>}</div>
      </div>
      <small className="shop-form-note">Ngày ra đơn là ngày dùng để lọc biểu đồ. Ngày hoàn thành có thể để trống và cập nhật sau khi đơn giao thành công.</small>
    </section>

    <section className="orders-card shop-filter-card">
      <div className="date-filter-heading"><span className="date-filter-icon">◷</span><div><strong>Lọc đơn bán</strong><small>Biểu đồ và danh sách bên dưới cùng thay đổi theo bộ lọc.</small></div></div>
      <div className="date-filter-controls"><label><span>Năm</span><select value={selectedYear} onChange={(e) => { setSelectedYear(e.target.value); setSelectedMonth('all'); setSelectedDay('all') }}><option value="all">Tất cả năm</option>{availableYears.map((year) => <option key={year} value={year}>{year}</option>)}</select></label><label><span>Tháng</span><select value={selectedMonth} onChange={(e) => { setSelectedMonth(e.target.value); setSelectedDay('all') }}><option value="all">Tất cả tháng</option>{availableMonths.map((month) => <option key={month} value={month}>Tháng {Number(month)}</option>)}</select></label><label><span>Ngày</span><select value={selectedDay} onChange={(e) => setSelectedDay(e.target.value)} disabled={selectedMonth === 'all'}><option value="all">Tất cả ngày</option>{availableDays.map((day) => <option key={day} value={day}>Ngày {Number(day)}</option>)}</select></label></div>
    </section>

    <div className="dashboard-cards shop-summary-cards"><div><span>Đơn bán</span><strong>{filteredSales.length}</strong></div><div><span>Doanh thu</span><strong>{formatVnd(totalRevenue)}</strong></div><div><span>Tổng giá vốn</span><strong>{formatVnd(totalCost)}</strong></div><div><span>Lợi nhuận</span><strong className={totalProfit >= 0 ? 'profit-positive' : 'profit-negative'}>{formatVnd(totalProfit)}</strong></div></div>

    <section className="orders-card shop-chart-card"><div className="shop-chart-heading"><div><p className="eyebrow">BIỂU ĐỒ THEO THÁNG</p><h2>Doanh số / giá vốn / lợi nhuận</h2></div><small>Bấm vào một cột để xem số tiền chi tiết. Giá vốn = giá tệ quy đổi + phí VC Purchase + phí VC Việt Nam.</small></div>{monthlyRows.length ? <div className="shop-month-chart">{monthlyRows.map((row) => { const monthLabel = row.key === 'unknown' ? 'Chưa rõ ngày' : `${row.key.slice(5, 7)}/${row.key.slice(0, 4)}`; return <div className={`shop-month-column ${selectedChartMonth === row.key ? 'selected' : ''}`} key={row.key} role="button" tabIndex="0" onClick={() => setSelectedChartMonth(row.key)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedChartMonth(row.key) } }} aria-label={`Xem số tiền tháng ${monthLabel}`}><div className="shop-month-bars"><span className="shop-chart-bar shop-chart-revenue" style={{ height: `${row.revenue / chartMax * 100}%` }} title={`Doanh số: ${formatVnd(row.revenue)}`} /><span className="shop-chart-bar shop-chart-cost" style={{ height: `${row.cost / chartMax * 100}%` }} title={`Giá vốn: ${formatVnd(row.cost)}`} /><span className="shop-chart-bar shop-chart-profit" style={{ height: `${Math.max(0, row.profit) / chartMax * 100}%` }} title={`Lợi nhuận: ${formatVnd(row.profit)}`} /></div><strong>{monthLabel}</strong></div> })}</div> : <div className="empty-state">Chưa có dữ liệu trong khoảng thời gian này.</div>}{selectedChart && <div className="shop-chart-detail"><strong>Chi tiết tháng {selectedChart.key === 'unknown' ? 'chưa rõ ngày' : `${selectedChart.key.slice(5, 7)}/${selectedChart.key.slice(0, 4)}`}</strong><div><span><i className="legend-revenue" />Doanh số <b>{formatVnd(selectedChart.revenue)}</b></span><span><i className="legend-cost" />Giá vốn <b>{formatVnd(selectedChart.cost)}</b></span><span><i className="legend-profit" />Lợi nhuận <b className={selectedChart.profit >= 0 ? 'profit-positive' : 'profit-negative'}>{formatVnd(selectedChart.profit)}</b></span></div></div>}<div className="chart-legend"><span className="legend-revenue" /> Doanh số <span className="legend-cost" /> Giá vốn <span className="legend-profit" /> Lợi nhuận</div></section>

    <section className="orders-card shop-table"><div className="shop-table-scroll"><div className="shop-table-head"><strong>Đơn / SKU</strong><strong>SL</strong><strong>Doanh thu</strong><strong>Giá tệ gốc</strong><strong>Giá tệ quy đổi</strong><strong>VC Purchase</strong><strong>Cân nặng</strong><strong>VC Việt Nam</strong><strong>Tổng giá vốn</strong><strong>Ngày ra đơn</strong><strong>Ngày hoàn thành</strong><strong>Lợi nhuận</strong><strong>Thao tác</strong></div>{filteredSales.length ? filteredSales.map((sale) => { const sku = skuMaster.find((item) => item.id === sale.sku) || {}; const details = getSaleDetails(sale); return <div className="shop-table-row" key={`${sale.id}-${sale.sku}`}><strong className="shop-product"><span className="shop-product-image">{sku.image ? <img src={sku.image} alt={sku.name} /> : '🛍️'}</span><span>{sale.sku || '-'}<small>{sku.name || 'Chưa có SKU Master'}</small></span></strong><span>{details.quantity}</span><span>{formatVnd(details.revenue)}</span><span>¥{details.originalCny.toFixed(2)}</span><span>{formatVnd(details.originalVnd)}</span><span>{formatVnd(details.purchaseShipping)}</span><span>{details.weight > 0 ? `${details.weight.toFixed(2)} kg` : '-'}</span><span>{formatVnd(details.vietnamShipping)}</span><span>{formatVnd(details.totalCost)}</span><span>{sale.orderDate || localDateValue(sale.date) || '-'}</span><span>{sale.completedDate || '-'}</span><strong className={details.profit >= 0 ? 'profit-positive' : 'profit-negative'}>{formatVnd(details.profit)}</strong><div className="shop-row-actions"><button type="button" className="shop-edit" onClick={() => editSale(sale)} disabled={saving}>Sửa</button><button type="button" className="shop-delete" onClick={() => deleteSale(sale)} disabled={saving}>Xóa</button></div></div> }) : <div className="empty-state">Chưa có đơn bán trong khoảng thời gian này.</div>}</div></section>
  </main>
}

function DashboardPage({ skuMaster, orders, exchangeRate, formatVnd, sales, skuLinks }) {
  const data = skuMaster.map((sku) => { const items = sales.filter((x) => x.sku === sku.id); const qty = items.reduce((n, x) => n + Number(x.quantity || 0), 0); const revenue = items.reduce((n, x) => n + Number(x.revenue || 0), 0); const shipping = items.reduce((n, x) => n + Number(x.shipping || 0), 0); let purchaseQty = 0; let purchaseCny = 0; orders.forEach((order) => order.items.forEach((item) => { if ((skuLinks[purchaseItemKey(order, item)] || getAutoMatchedSku(item, skuMaster)?.id) === sku.id) { const n = Number(item.quantity || 0); purchaseQty += n; purchaseCny += n * Number(item.unit_price_cny || 0) } })); const cost = purchaseQty ? qty * (purchaseCny / purchaseQty) * Number(exchangeRate || 0) : 0; return { ...sku, qty, revenue, shipping, cost, profit: revenue - cost - shipping } }).filter((x) => x.qty)
  data.forEach((row) => {
    const purchaseShipping = orders.reduce((sum, order) => {
      const allQty = order.items.reduce((n, item) => n + Number(item.quantity || 0), 0)
      const skuQty = order.items.filter((item) => getAutoMatchedSku(item, skuMaster)?.id === row.id).reduce((n, item) => n + Number(item.quantity || 0), 0)
      const inventoryQty = orders.reduce((grandTotal, currentOrder) => grandTotal + currentOrder.items.reduce((n, item) => n + Number(item.quantity || 0), 0), 0)
      return sum + (allQty && inventoryQty ? calculateShippingCost(order.tuanvinh?.weight_kg) * skuQty / allQty * row.qty / inventoryQty : 0)
    }, 0)
    row.shipping += purchaseShipping
    row.profit -= purchaseShipping
  })
  const inventoryQty = orders.reduce((sum, order) => sum + order.items.reduce((n, item) => n + Number(item.quantity || 0), 0), 0)
  const soldQty = data.reduce((sum, row) => sum + row.qty, 0)
  const purchaseShippingTotal = inventoryQty ? orders.reduce((sum, order) => sum + calculateShippingCost(order.tuanvinh?.weight_kg), 0) * soldQty / inventoryQty : 0
  const total = (key) => {
    const value = data.reduce((n, x) => n + x[key], 0)
    if (key === 'shipping') return value + purchaseShippingTotal
    if (key === 'profit') return value - purchaseShippingTotal
    return value
  }
  const totalShipping = total('shipping') + purchaseShippingTotal
  const totalProfit = total('profit') - purchaseShippingTotal
  const max = Math.max(1, ...data.map((x) => x.revenue))
  return <main className="dashboard"><section className="page-heading"><div><p className="eyebrow">DASHBOARD</p><h1>Doanh số & lợi nhuận</h1><p className="heading-description">Tổng quan hiệu quả bán hàng theo SKU.</p></div></section><div className="dashboard-cards"><div><span>Sản phẩm bán</span><strong>{total('qty')}</strong></div><div><span>Doanh thu</span><strong>{formatVnd(total('revenue'))}</strong></div><div><span>Phí vận chuyển</span><strong>{formatVnd(total('shipping'))}</strong></div><div><span>Lợi nhuận</span><strong className="profit-positive">{formatVnd(total('profit'))}</strong></div></div><section className="orders-card dashboard-chart"><h2>Doanh thu theo SKU</h2>{data.length ? data.map((row) => <div className="dashboard-bar-row" key={row.id}><strong>{row.id}</strong><div><span className="bar revenue-bar" style={{ width: `${row.revenue / max * 100}%` }} /><span className="bar profit-bar" style={{ width: `${Math.max(0, row.profit) / max * 100}%` }} /></div><b>{formatVnd(row.revenue)}</b></div>) : <div className="empty-state">Chưa có dữ liệu bán hàng.</div>}<div className="chart-legend"><span className="legend-revenue" /> Doanh thu <span className="legend-profit" /> Lợi nhuận</div></section></main>
}

function SalesDashboardPage({ skuMaster, orders, exchangeRate, formatVnd, sales, skuLinks, salesLoading, salesError }) {
  const [selectedYear, setSelectedYear] = useState('all')
  const [selectedMonth, setSelectedMonth] = useState('all')
  const [selectedDay, setSelectedDay] = useState('all')

  const availableYears = useMemo(() => [...new Set(
    sales.map((sale) => localDateValue(sale.orderDate || sale.date).slice(0, 4)).filter(Boolean)
  )].sort((a, b) => b.localeCompare(a)), [sales])

  const availableMonths = useMemo(() => [...new Set(
    sales
      .map((sale) => localDateValue(sale.orderDate || sale.date))
      .filter((date) => date && (selectedYear === 'all' || date.startsWith(`${selectedYear}-`)))
      .map((date) => date.slice(5, 7))
  )].sort((a, b) => Number(a) - Number(b)), [sales, selectedYear])

  const availableDays = useMemo(() => [...new Set(
    sales
      .map((sale) => localDateValue(sale.orderDate || sale.date))
      .filter((date) => date && (selectedYear === 'all' || date.startsWith(`${selectedYear}-`)) && (selectedMonth === 'all' || date.slice(5, 7) === selectedMonth))
      .map((date) => date.slice(8, 10))
  )].sort((a, b) => Number(a) - Number(b)), [sales, selectedYear, selectedMonth])

  const filteredSales = useMemo(() => sales.filter((sale) => {
    const date = localDateValue(sale.orderDate || sale.date)
    return (selectedYear === 'all' || date.startsWith(`${selectedYear}-`))
      && (selectedMonth === 'all' || date.slice(5, 7) === selectedMonth)
      && (selectedDay === 'all' || date.slice(8, 10) === selectedDay)
  }), [sales, selectedYear, selectedMonth, selectedDay])

  const rows = useMemo(() => skuMaster.map((sku) => {
    const list = filteredSales.filter((sale) => sale.sku === sku.id)
    const quantity = list.reduce((sum, sale) => sum + Number(sale.quantity || 0), 0)
    const revenue = list.reduce((sum, sale) => sum + Number(sale.revenue || 0), 0)
    const shipping = list.reduce((sum, sale) => sum + Number(sale.shipping || 0), 0)
    let purchaseQuantity = 0
    let purchaseCny = 0
    orders.forEach((order) => order.items.forEach((item) => {
      const linkedSku = skuLinks[purchaseItemKey(order, item)] || getAutoMatchedSku(item, skuMaster)?.id
      if (linkedSku !== sku.id) return
      const quantity = Number(item.quantity || 0)
      purchaseQuantity += quantity
      purchaseCny += quantity * Number(item.unit_price_cny || 0)
    }))
    const cost = purchaseQuantity ? quantity * (purchaseCny / purchaseQuantity) * Number(exchangeRate || 0) : 0
    return { ...sku, quantity, revenue, shipping, cost, profit: revenue - cost - shipping }
  }).filter((row) => row.quantity || row.revenue), [skuMaster, orders, exchangeRate, filteredSales, skuLinks])

  const totalQuantity = filteredSales.reduce((sum, sale) => sum + Number(sale.quantity || 0), 0)
  const totalRevenue = filteredSales.reduce((sum, sale) => sum + Number(sale.revenue || 0), 0)
  const completedCount = filteredSales.filter((sale) => sale.completedDate).length
  const totalProfit = rows.reduce((sum, row) => sum + row.profit, 0)
  const maxRevenue = Math.max(1, ...rows.map((row) => row.revenue))

  return <main className="dashboard">
    <section className="page-heading"><div><p className="eyebrow">DASHBOARD</p><h1>Thống kê SAMU.SHOP</h1><p className="heading-description">Theo dõi doanh thu theo ngày ghi đơn, SKU và trạng thái hoàn thành.</p></div></section>
    {salesError && <div className="error-box">⚠️ {salesError}</div>}
    <section className="orders-card dashboard-filter-card"><div className="date-filter-heading"><span className="date-filter-icon">◷</span><div><strong>Lọc theo ngày ghi đơn</strong><small>Chọn năm, tháng hoặc ngày để xem doanh thu.</small></div></div><div className="date-filter-controls"><label><span>Năm</span><select value={selectedYear} onChange={(e) => { setSelectedYear(e.target.value); setSelectedMonth('all'); setSelectedDay('all') }}><option value="all">Tất cả năm</option>{availableYears.map((year) => <option key={year} value={year}>{year}</option>)}</select></label><label><span>Tháng</span><select value={selectedMonth} onChange={(e) => { setSelectedMonth(e.target.value); setSelectedDay('all') }}><option value="all">Tất cả tháng</option>{availableMonths.map((month) => <option key={month} value={month}>Tháng {Number(month)}</option>)}</select></label><label><span>Ngày</span><select value={selectedDay} onChange={(e) => setSelectedDay(e.target.value)} disabled={selectedMonth === 'all'}><option value="all">Tất cả ngày</option>{availableDays.map((day) => <option key={day} value={day}>Ngày {Number(day)}</option>)}</select></label></div></section>
    <div className="dashboard-cards"><div><span>Đơn bán</span><strong>{filteredSales.length}</strong></div><div><span>Sản phẩm bán</span><strong>{totalQuantity}</strong></div><div><span>Doanh thu</span><strong>{formatVnd(totalRevenue)}</strong></div><div><span>Đã hoàn thành</span><strong>{completedCount}</strong></div><div><span>Lợi nhuận ước tính</span><strong className={totalProfit >= 0 ? 'profit-positive' : 'profit-negative'}>{formatVnd(totalProfit)}</strong></div></div>
    <section className="orders-card dashboard-chart"><h2>Doanh thu theo SKU</h2>{salesLoading ? <div className="empty-state">Đang tải dữ liệu SAMU.SHOP...</div> : rows.length ? rows.map((row) => <div className="dashboard-bar-row" key={row.id}><strong>{row.id}<small>{row.name}</small></strong><div><span className="bar revenue-bar" style={{ width: `${row.revenue / maxRevenue * 100}%` }} /><span className="bar profit-bar" style={{ width: `${Math.max(0, row.profit) / maxRevenue * 100}%` }} /></div><b>{formatVnd(row.revenue)}</b></div>) : <div className="empty-state">Chưa có đơn bán trong khoảng thời gian này.</div>}<div className="chart-legend"><span className="legend-revenue" /> Doanh thu <span className="legend-profit" /> Lợi nhuận</div></section>
  </main>
}
function ImageViewer({ image, name, onClose }) {
  return (
    <div className="image-viewer-backdrop" onClick={onClose}>
      <div className="image-viewer" onClick={(e) => e.stopPropagation()}>
        <button className="image-viewer-close" type="button" onClick={onClose}>×</button>
        <img src={image} alt={name || 'Product'} />
        {name && <div className="image-viewer-caption">{name}</div>}
      </div>
    </div>
  )
}

function App() {
  const [orders, setOrders] = useState([])
  const [taobaoSyncedAt, setTaobaoSyncedAt] = useState(null)
  const [activeTab, setActiveTab] = useState('purchase')

const [skuMaster, setSkuMaster] = useState([])

const [skuLinks, setSkuLinks] = useState({})

const [shopSales, setShopSales] = useState([])
const [shopSalesLoading, setShopSalesLoading] = useState(true)
const [shopSalesError, setShopSalesError] = useState('')

useEffect(() => {
  let cancelled = false

  async function loadRemoteShopSales() {
    try {
      const remoteSalesRaw = await fetchShopSales()
      const remoteSales = normalizeShopSales(remoteSalesRaw)
      if (cancelled) return

      // Migrate existing browser data once, then remove the local copy.
      let legacySales = []
      try {
        const parsed = JSON.parse(localStorage.getItem('samuchan_shop_sales_v1') || '[]')
        legacySales = Array.isArray(parsed) ? parsed : []
      } catch {}

      if (remoteSales.length === 0 && legacySales.length > 0) {
        const migrated = await saveShopSales(legacySales)
        if (cancelled) return
        setShopSales(migrated)
      } else {
        const needsSalesMigration = remoteSalesRaw.some((sale, index) => {
          const normalized = remoteSales[index]
          return sale.shopName !== normalized.shopName
            || sale.orderDate !== normalized.orderDate
            || sale.completedDate !== normalized.completedDate
        })
        if (needsSalesMigration) {
          const migrated = await saveShopSales(remoteSales)
          if (cancelled) return
          setShopSales(migrated)
        } else {
          setShopSales(remoteSales)
        }
      }

      try { localStorage.removeItem('samuchan_shop_sales_v1') } catch {}
      setShopSalesError('')
    } catch (error) {
      if (!cancelled) {
        setShopSales([])
        setShopSalesError(error.message || 'Khong doc duoc don SAMU.SHOP tu Railway')
      }
    } finally {
      if (!cancelled) setShopSalesLoading(false)
    }
  }

  loadRemoteShopSales()

  return () => { cancelled = true }
}, [])

const saveRemoteShopSales = useCallback(async (nextSales) => {
  try {
    const saved = await saveShopSales(nextSales)
    setShopSales(saved)
    setShopSalesError('')
    return true
  } catch (error) {
    setShopSalesError(error.message || 'Khong luu duoc don SAMU.SHOP len Railway')
    return false
  }
}, [])

const getSalesForShop = (shopName) => shopSales.filter((sale) => normalizeShopName(sale.shopName) === shopName)

const saveRemoteShopSalesFor = useCallback(async (shopName, nextShopSales) => {
  const otherShopSales = shopSales.filter((sale) => normalizeShopName(sale.shopName) !== shopName)
  const normalizedShopSales = nextShopSales.map((sale) => ({ ...sale, shopName }))
  return saveRemoteShopSales([...otherShopSales, ...normalizedShopSales])
}, [shopSales, saveRemoteShopSales])

// ============================================================
//  LOAD SKU FROM RAILWAY
// ============================================================

useEffect(() => {
  let cancelled = false

  async function loadRemoteSku() {
    // ============================================
    // 1. Đọc dữ liệu cũ trên máy
    // ============================================
    const localMaster = []
    const localLinks = {}

    // ============================================
    // 2. Đọc SKU Master từ Railway
    // ============================================
    const remoteMaster = await fetchSkuMaster()

    if (cancelled) return

    if (Array.isArray(remoteMaster)) {
      if (remoteMaster.length > 0) {
        // Railway đã có dữ liệu → dùng Railway
        setSkuMaster(remoteMaster)
        console.log(
          `[SKU MASTER] Loaded ${remoteMaster.length} SKU from Railway`
        )
      } else if (localMaster.length > 0) {
        // Railway đang trống nhưng máy này có dữ liệu cũ
        // → migrate local lên Railway
        console.log(
          `[SKU MASTER] Railway empty → migrating ${localMaster.length} local SKU`
        )

        setSkuMaster(localMaster)

        await saveSkuMaster(localMaster)
      } else {
        setSkuMaster([])
      }
    }

    // ============================================
    // 3. Đọc Purchase → SKU links từ Railway
    // ============================================
    const remoteLinks = await fetchSkuLinks()

    if (cancelled) return

    const hasRemoteLinks =
      remoteLinks &&
      typeof remoteLinks === 'object' &&
      Object.keys(remoteLinks).length > 0

    const hasLocalLinks =
      localLinks &&
      typeof localLinks === 'object' &&
      Object.keys(localLinks).length > 0

    if (hasRemoteLinks) {
      // Railway đã có mapping → dùng Railway
      setSkuLinks(remoteLinks)
      console.log(
        `[SKU LINKS] Loaded ${Object.keys(remoteLinks).length} mappings from Railway`
      )
    } else if (hasLocalLinks) {
      // Railway chưa có mapping → migrate mapping cũ
      console.log(
        `[SKU LINKS] Railway empty → migrating ${Object.keys(localLinks).length} local mappings`
      )

      setSkuLinks(localLinks)

      await saveSkuLinks(localLinks)
    } else {
      setSkuLinks({})
    }
  }

  loadRemoteSku()

  return () => {
    cancelled = true
  }
}, [])
  const [updatedAt, setUpdatedAt] = useState(null)
  const [activeFilter, setActiveFilter] = useState('Tất cả')
  const [search, setSearch] = useState('')
  const [selectedYear, setSelectedYear] = useState('Tất cả')
  const [selectedMonth, setSelectedMonth] = useState('Tất cả')
  const [selectedDay, setSelectedDay] = useState('Tất cả')
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [loading, setLoading] = useState(true)
  const [logisticsLoading, setLogisticsLoading] = useState(false)
  const [error, setError] = useState('')
  const [exchangeRate, setExchangeRate] = useState(0)

  useEffect(() => {
    let cancelled = false

    fetchAppSettings()
      .then(async (settings) => {
        if (cancelled) return

        const hasRemoteRate = Object.prototype.hasOwnProperty.call(settings, 'exchangeRate')
        let rate = Number(settings.exchangeRate || 0)

        if (!hasRemoteRate) {
          try {
            const legacyRate = Number(localStorage.getItem('samuchan_exchange_rate') || 0)
            if (legacyRate > 0) {
              rate = legacyRate
              await saveAppSettings({ exchangeRate: legacyRate })
            }
          } catch {}
        }

        setExchangeRate(rate)

        try {
          localStorage.removeItem('samuchan_exchange_rate')
          localStorage.removeItem('samuchan_active_tab')
          localStorage.removeItem('samuchan_selected_year')
          localStorage.removeItem('samuchan_selected_month')
          localStorage.removeItem('samuchan_selected_day')
        } catch {}
      })
      .catch((settingsError) => {
        if (!cancelled) setError(settingsError.message || 'Khong doc duoc ty gia tu Railway')
      })

    return () => { cancelled = true }
  }, [])

  const refreshOneTuanVinh = useCallback(async (order) => {
    const tracking = String(order?.tracking_number || '').trim()

    if (!tracking) return null
    try {
      const response = await fetch(
        '/api/tuanvinh/refresh-order',
        {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
          },
          body: JSON.stringify({
            order_id: order.order_id,
          }),
        }
      )

      const payload = await readApiJson(response)

      if (!response.ok || payload?.success === false) {
        throw new Error(
          payload?.message ||
          payload?.error ||
          'Không tra được Tuấn Vĩnh'
        )
      }

      const tv =
        payload?.data ||
        payload?.tuanvinh ||
        payload?.order?.tuanvinh ||
        payload
      const hasExitedVietnam =
        Array.isArray(tv?.history) &&
        tv.history.some((item) => {
          const text =
            typeof item === 'string'
              ? item
              : String(
                  item?.status ||
                  item?.name ||
                  item?.text ||
                  ''
                )

          return text.includes('Xuất kho Việt Nam')
        })
      if (!tv || tv.success === false) {
        throw new Error(
          tv?.message ||
          'Tuấn Vĩnh không trả dữ liệu hợp lệ'
        )
      }

      setOrders((current) =>
        current.map((item) =>
          item.order_id === order.order_id
            ? {
                ...item,
                tuanvinh: tv,
                tuanvinh_locked:
                  item.tuanvinh_locked === true ||
                  hasExitedVietnam,
                status:
                  tv.current_status || item.status,
              }
            : item
        )
      )

      setSelectedOrder((current) =>
        current && current.order_id === order.order_id
          ? {
              ...current,
              tuanvinh: tv,
              tuanvinh_locked:
                current.tuanvinh_locked === true ||
                hasExitedVietnam,
              status:
                tv.current_status || current.status,
            }
          : current
      )

      return tv
    } catch (err) {
      console.error(
        `[TUANVINH] ${tracking}:`,
        err
      )
      throw err
    }
  }, [])

  const loadOrders = useCallback(async () => {
    try {
      setLoading(true); setError('')
      const response = await fetch('/api/taobao/orders', { cache: 'no-store' })
      const data = await readApiJson(response)
      if (!response.ok) throw new Error(data.message || 'Không đọc được dữ liệu Taobao')
      const normalized = normalizeOrders(data)
      setOrders(normalized)
      setUpdatedAt(data.updated_at || null)
      setTaobaoSyncedAt(data.taobao_synced_at || null)
      setLoading(false)
      return data
    } catch (err) {
      setError(err.message || 'Không đọc được dữ liệu Taobao')
      setLoading(false)
    }
  }, [])

  const syncAll = useCallback(async () => {
    try {
      setLoading(true); setError('')
      const response = await fetch('/api/taobao/sync', { method: 'POST' })
      const data = await readApiJson(response)
      if (!response.ok || data?.success === false) {
        const detail = String(data?.detail || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-8)
          .join(' ')
        throw new Error([data?.message || 'Không thể đồng bộ Taobao', detail].filter(Boolean).join(' '))
      }
      await loadOrders()
      // Dùng mốc backend vừa trả về để UI phản ánh ngay cả khi dev server
      // vẫn đang giữ lần đọc file trước đó trong một khoảnh khắc.
      setTaobaoSyncedAt(data.taobao_synced_at || null)
    } catch (err) {
      setError(err.message || 'Không thể đồng bộ Taobao')
      setLoading(false)
    }
  }, [loadOrders])

  useEffect(() => { loadOrders() }, [loadOrders])

  const availableYears = useMemo(() => {
    return [...new Set(
      orders
        .map((order) => dateKey(order.order_date))
        .filter((key) => /^20\d{2}-\d{2}-\d{2}$/.test(key))
        .map((key) => key.slice(0, 4))
    )].sort((a, b) => b.localeCompare(a))
  }, [orders])

  const availableMonths = useMemo(() => {
    const source = selectedYear === 'Tất cả'
      ? orders
      : orders.filter((order) => dateKey(order.order_date).startsWith(`${selectedYear}-`))

    return [...new Set(
      source
        .map((order) => dateKey(order.order_date))
        .filter((key) => /^20\d{2}-\d{2}-\d{2}$/.test(key))
        .map((key) => key.slice(5, 7))
    )].sort((a, b) => Number(a) - Number(b))
  }, [orders, selectedYear])

  const availableDays = useMemo(() => {
    if (selectedMonth === 'Tất cả') return []

    return [...new Set(
      orders
        .map((order) => dateKey(order.order_date))
        .filter((key) => {
          if (!/^20\d{2}-\d{2}-\d{2}$/.test(key)) return false
          const yearMatches = selectedYear === 'Tất cả' || key.startsWith(`${selectedYear}-`)
          const monthMatches = key.slice(5, 7) === selectedMonth
          return yearMatches && monthMatches
        })
        .map((key) => key.slice(8, 10))
    )].sort((a, b) => Number(a) - Number(b))
  }, [orders, selectedYear, selectedMonth])

  const handleYearChange = (value) => {
    setSelectedYear(value)
    setSelectedMonth('Tất cả')
    setSelectedDay('Tất cả')
  }

  const handleMonthChange = (value) => {
    setSelectedMonth(value)
    setSelectedDay('Tất cả')
  }

  const handleDayChange = (value) => {
    setSelectedDay(value)
  }

  const filteredOrders = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return orders.filter((order) => {
      const orderDate = dateKey(order.order_date)
      const matchesFilter = activeFilter === 'Tất cả' || statusCategory(order) === activeFilter
      const matchesYear = selectedYear === 'Tất cả' || orderDate.startsWith(`${selectedYear}-`)
      const matchesMonth = selectedMonth === 'Tất cả' || orderDate.slice(5, 7) === selectedMonth
      const matchesDay = selectedDay === 'Tất cả' || orderDate.slice(8, 10) === selectedDay
      const searchable = [
        order.order_id, order.shop_name, order.tracking_number,
        ...order.items.flatMap((item) => [item.product_name, item.sku, translateSku(item.sku)]),
      ].filter(Boolean).join(' ').toLowerCase()
      return matchesFilter
        && matchesYear
        && matchesMonth
        && matchesDay
        && (!keyword || searchable.includes(keyword))
    })
  }, [orders, activeFilter, search, selectedYear, selectedMonth, selectedDay])

  const skuPurchaseOrders = useMemo(() => {
    return orders.filter((order) => {
      const orderDate = dateKey(order.order_date)
      const matchesYear = selectedYear === 'Tất cả' || orderDate.startsWith(`${selectedYear}-`)
      const matchesMonth = selectedMonth === 'Tất cả' || orderDate.slice(5, 7) === selectedMonth
      const matchesDay = selectedDay === 'Tất cả' || orderDate.slice(8, 10) === selectedDay

      return matchesYear && matchesMonth && matchesDay
    })
  }, [orders, selectedYear, selectedMonth, selectedDay])

  const groupedOrders = useMemo(() => {
    const map = new Map()
    filteredOrders.forEach((order) => {
      const key = dateKey(order.order_date)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(order)
    })
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [filteredOrders])

  // Các card tổng quan phải phản ánh đúng tập dữ liệu đang được lọc
  // (năm / tháng / ngày + trạng thái + tìm kiếm), không còn tính trên toàn bộ orders.
  const totalQuantity = filteredOrders.reduce(
    (sum, order) => sum + order.items.reduce((s, item) => s + Number(item.quantity || 0), 0),
    0
  )
  const totalCny = filteredOrders.reduce(
    (sum, order) => sum + Number(order.order_total_cny || 0),
    0
  )
  const trackingCount = filteredOrders.filter((order) => order.tracking_number).length
  const totalVnd = totalCny * exchangeRate
  const totalShippingVnd = filteredOrders.reduce(
    (sum, order) => sum + calculateShippingCost(order.tuanvinh?.weight_kg),
    0
  )

  const handleExchangeRateChange = (value) => {
    const normalized = String(value).replace(/,/g, '.').replace(/[^0-9.]/g, '')
    const rate = Number(normalized) || 0
    setExchangeRate(rate)
    saveAppSettings({ exchangeRate: rate }).catch((settingsError) => {
      setError(settingsError.message || 'Khong luu duoc ty gia len Railway')
    })
  }

  const formatVnd = (value) => `${Math.round(value).toLocaleString('vi-VN')} ₫`

  const formatTime = (value) => {
    if (!value) return 'Chưa đồng bộ'
    try { return new Date(value).toLocaleString('vi-VN') } catch { return value }
  }

  const handleTrackingSaved = (updatedOrder) => {
    setOrders((current) => current.map((item) =>
      item.order_id === updatedOrder.order_id ? { ...item, ...updatedOrder } : item
    ))
    setSelectedOrder((current) => current && current.order_id === updatedOrder.order_id
      ? { ...current, ...updatedOrder }
      : current
    )
  }

  const handleSkuLinkSaved = useCallback((order, item, masterId) => {
    const key = purchaseItemKey(order, item)
    setSkuLinks((current) => {
      const next = { ...current }
      if (masterId) next[key] = masterId
      else delete next[key]
      saveSkuLinks(next)
      return next
    })
  }, [])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src={samuchanLogo} alt="SAMUCHAN Gift & Custom" />
        </div>
        <button className="sync-button" type="button" onClick={syncAll} disabled={loading}><span>↻</span>{loading ? 'Đang đồng bộ...' : logisticsLoading ? 'Đang cập nhật Tuấn Vĩnh...' : 'Cập nhật Taobao'}</button>
      </header>

      <div className="samuchan-tabs">
  <button
    type="button"
    className={activeTab === 'purchase' ? 'active' : ''}
    onClick={() => setActiveTab('purchase')}
  >
    🧾 PURCHASE
  </button>

  <button
    type="button"
    className={activeTab === 'sku-master' ? 'active' : ''}
    onClick={() => setActiveTab('sku-master')}
  >
    🏷️ SKU MASTER
  </button>

  <button
    type="button"
    className={activeTab === 'shop' ? 'active' : ''}
    onClick={() => setActiveTab('shop')}
  >
    🛍️ SAMU.SHOP
  </button>

  <button
    type="button"
    className={activeTab === 'djk-bat' ? 'active' : ''}
    onClick={() => setActiveTab('djk-bat')}
  >
    🛍️ DJK BAT
  </button>

  <button
    type="button"
    className={activeTab === 'nomori-home' ? 'active' : ''}
    onClick={() => setActiveTab('nomori-home')}
  >
    🛍️ NOMORI HOME
  </button>
</div>

{activeTab === 'sku-master' ? (
  <SkuMasterPage
    skuMaster={skuMaster}
    setSkuMaster={setSkuMaster}
    orders={skuPurchaseOrders}
    skuLinks={skuLinks}
    setSkuLinks={setSkuLinks}
    exchangeRate={exchangeRate}
    formatVnd={formatVnd}
    selectedYear={selectedYear}
    selectedMonth={selectedMonth}
    selectedDay={selectedDay}
    availableYears={availableYears}
    availableMonths={availableMonths}
    availableDays={availableDays}
    onYearChange={handleYearChange}
    onMonthChange={handleMonthChange}
    onDayChange={handleDayChange}
    onRefreshPurchases={syncAll}
  />
) : activeTab === 'shop' ? (
  <ShopPage shopName="SAMU.SHOP" skuMaster={skuMaster} orders={orders} exchangeRate={exchangeRate} formatVnd={formatVnd} sales={getSalesForShop('SAMU.SHOP')} onSalesChange={(nextSales) => saveRemoteShopSalesFor('SAMU.SHOP', nextSales)} skuLinks={skuLinks} salesLoading={shopSalesLoading} salesError={shopSalesError} />
) : activeTab === 'djk-bat' ? (
  <ShopPage shopName="DJK BAT" skuMaster={skuMaster} orders={orders} exchangeRate={exchangeRate} formatVnd={formatVnd} sales={getSalesForShop('DJK BAT')} onSalesChange={(nextSales) => saveRemoteShopSalesFor('DJK BAT', nextSales)} skuLinks={skuLinks} salesLoading={shopSalesLoading} salesError={shopSalesError} />
) : activeTab === 'nomori-home' ? (
  <ShopPage shopName="NOMORI HOME" skuMaster={skuMaster} orders={orders} exchangeRate={exchangeRate} formatVnd={formatVnd} sales={getSalesForShop('NOMORI HOME')} onSalesChange={(nextSales) => saveRemoteShopSalesFor('NOMORI HOME', nextSales)} skuLinks={skuLinks} salesLoading={shopSalesLoading} salesError={shopSalesError} />
) : (
  <main className="dashboard">
        <section className="page-heading">
          <div><p className="eyebrow">PURCHASES</p><h1>Purchases</h1><p className="heading-description">Quản lý đơn mua hàng Taobao theo ngày và Order ID.</p></div>
          <div className="last-sync"><span className="online-dot" />{orders.length ? (taobaoSyncedAt ? `Đồng bộ Taobao · ${formatTime(taobaoSyncedAt)}` : 'Chưa có mốc đồng bộ Taobao') : 'Chưa có dữ liệu'}</div>
        </section>
        {error && <div className="error-box">⚠️ {error}</div>}

        <section className="summary-grid">
          <div className="summary-card"><div className="summary-icon purple">🧾</div><div><span>Tổng đơn</span><strong>{filteredOrders.length}</strong></div></div>
          <div className="summary-card"><div className="summary-icon blue">📦</div><div><span>Tổng sản phẩm</span><strong>{totalQuantity}</strong></div></div>
          <div className="summary-card"><div className="summary-icon gold">¥</div><div><span>Tổng tiền</span><strong>¥{totalCny.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></div></div>
          <div className="summary-card exchange-card">
            <div className="summary-icon rate">¥→₫</div>
            <div className="exchange-content">
              <span>Tỷ giá CNY hiện tại</span>
              <div className="exchange-input-wrap">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={exchangeRate || ''}
                  onChange={(e) => handleExchangeRateChange(e.target.value)}
                  placeholder="3945"
                  aria-label="Tỷ giá CNY sang VND"
                />
              </div>
            </div>
          </div>
          <div className="summary-card converted-card">
            <div className="summary-icon converted">₫</div>
            <div><span>Tổng tiền Việt Nam</span><strong>{exchangeRate > 0 ? formatVnd(totalVnd) : 'Chưa nhập tỷ giá'}</strong></div>
          </div>
          <div className="summary-card converted-card shipping-summary-card">
            <div className="summary-icon shipping">🚚</div>
            <div><span>Tổng phí vận chuyển</span><strong>{totalShippingVnd > 0 ? formatVnd(totalShippingVnd) : 'Chưa có dữ liệu'}</strong></div>
          </div>
        </section>

        <section className="orders-card">
          <div className="date-filter-bar">
            <div className="date-filter-heading">
              <span className="date-filter-icon">◷</span>
              <div>
                <strong>Lọc theo ngày đặt hàng</strong>
                <small>Có thể chọn năm → tháng → ngày, hoặc lọc tháng/ngày trên toàn bộ dữ liệu</small>
              </div>
            </div>

            <div className="date-filter-controls">
              <label>
                <span>Năm</span>
                <select value={selectedYear} onChange={(e) => handleYearChange(e.target.value)}>
                  <option value="Tất cả">Tất cả năm</option>
                  {availableYears.map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
              </label>

              <label>
                <span>Tháng</span>
                <select
                  value={selectedMonth}
                  onChange={(e) => handleMonthChange(e.target.value)}
                >
                  <option value="Tất cả">Tất cả tháng</option>
                  {availableMonths.map((month) => <option key={month} value={month}>Tháng {Number(month)}</option>)}
                </select>
              </label>

              <label>
                <span>Ngày</span>
                <select
                  value={selectedDay}
                  onChange={(e) => setSelectedDay(e.target.value)}
                  disabled={selectedMonth === 'Tất cả'}
                >
                  <option value="Tất cả">Tất cả ngày</option>
                  {availableDays.map((day) => <option key={day} value={day}>Ngày {Number(day)}</option>)}
                </select>
              </label>

              {(selectedYear !== 'Tất cả' || selectedMonth !== 'Tất cả' || selectedDay !== 'Tất cả') && (
                <button
                  type="button"
                  className="date-filter-reset"
                  onClick={() => {
                    setSelectedYear('Tất cả')
                    setSelectedMonth('Tất cả')
                    setSelectedDay('Tất cả')
                  }}
                >
                  × Xóa lọc ngày
                </button>
              )}
            </div>
          </div>

          <div className="toolbar">
            <div className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm Order ID, sản phẩm, shop, tracking..." />{search && <button type="button" onClick={() => setSearch('')}>×</button>}</div>
            <div className="filters">{['Tất cả', 'Chưa giao', 'Đang vận chuyển', 'Đã giao'].map((filter) => <button key={filter} type="button" className={activeFilter === filter ? 'active' : ''} onClick={() => setActiveFilter(filter)}>{filter}</button>)}</div>
          </div>

          <div className="orders-content">
            {groupedOrders.map(([date, dateOrders]) => (
              <section className="date-group" key={date}>
                <div className="date-heading"><div><span className="date-dot" /><h3>{formatDate(date)}</h3></div><span>{dateOrders.length} đơn</span></div>
                <div className="order-grid">
                  {dateOrders.map((order) => <OrderCard key={order.order_id} order={order} exchangeRate={exchangeRate} formatVnd={formatVnd} onClick={setSelectedOrder} onImageClick={(image, name) => setViewer({ image, name })} />)}
                </div>
              </section>
            ))}
            {!loading && filteredOrders.length === 0 && <div className="empty-state">Không tìm thấy đơn hàng phù hợp.</div>}
          </div>
          <div className="table-footer"><span>Hiển thị {filteredOrders.length} đơn · {trackingCount} đơn có tracking</span><span>{logisticsLoading ? 'Đang đồng bộ Tuấn Vĩnh...' : 'Click Order ID để xem sản phẩm'}</span></div>
        </section>
      </main>
      )}

      {
        selectedOrder && (
          <OrderDetailModal
            order={selectedOrder}
            exchangeRate={exchangeRate}
            formatVnd={formatVnd}
            onTrackingSaved={handleTrackingSaved}
            onRefreshTuanVinh={refreshOneTuanVinh}
            skuMaster={skuMaster}
            skuLinks={skuLinks}
            onSkuLinkSaved={handleSkuLinkSaved}
            onClose={() => setSelectedOrder(null)}
            onImageClick={(image, name) => setViewer({ image, name })}
          />
        )
      }
      {viewer && <ImageViewer image={viewer.image} name={viewer.name} onClose={() => setViewer(null)} />}
    </div>
  )
}

export default App
