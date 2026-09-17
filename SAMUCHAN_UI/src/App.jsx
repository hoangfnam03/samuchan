import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import samuchanLogo from './assets/samuchan-logo.png'

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

function OrderDetailModal({ order, onClose, onImageClick, exchangeRate, formatVnd, onTrackingSaved, onRefreshTuanVinh }) {
  const totalQuantity = order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
  const [trackingInput, setTrackingInput] = useState(order.tracking_number || '')
  const [trackingSaving, setTrackingSaving] = useState(false)
  const [trackingEditing, setTrackingEditing] = useState(false)
  const [trackingMessage, setTrackingMessage] = useState('')
  const [liveTuanVinh, setLiveTuanVinh] = useState(order.tuanvinh || null)

  useEffect(() => {
    setTrackingInput(order.tracking_number || '')
    setTrackingEditing(false)
    setTrackingMessage('')
    setLiveTuanVinh(order.tuanvinh || null)
  }, [order.order_id, order.tracking_number, order.tuanvinh])

  // Khi mở chi tiết một đơn đã có tracking, lấy dữ liệu logistics mới nhất
  // ngay cả khi đợt đồng bộ nền chưa chạy xong. API này cũng ghi dữ liệu về
  // order ở backend để các lần mở sau có thể dùng dữ liệu đã lưu.
  useEffect(() => {
    const tracking = String(order.tracking_number || '').trim()
    if (!tracking || liveTuanVinh?.success) return undefined

    let cancelled = false
    onRefreshTuanVinh({ ...order, tracking_number: tracking, forceTuanVinh: true })
      .then((data) => {
        if (!cancelled && data?.success) setLiveTuanVinh(data)
      })
      .catch((error) => {
        if (!cancelled) console.error(`[TUANVINH] ${tracking}:`, error)
      })

    return () => { cancelled = true }
  }, [order, liveTuanVinh, onRefreshTuanVinh])

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

      const data = await response.json()

      if (!response.ok || data?.success === false) {
        throw new Error(
          data?.message ||
          data?.error ||
          'Không lưu được tracking'
        )
      }

      // Backend đã lưu tracking và có thể đã tra Tuấn Vĩnh.
      let tv =
        data?.tuanvinh ||
        data?.order?.tuanvinh ||
        null

      let savedOrder = {
        ...order,
        ...(data?.order || {}),
        tracking_number: tracking,
      }

      if (tv?.success) {
        savedOrder.tuanvinh = tv
        savedOrder.status =
          tv.current_status ||
          savedOrder.status
      }

      // Cập nhật ngay popup.
      onTrackingSaved(savedOrder)

      setTrackingInput(tracking)
      setTrackingEditing(false)

      if (tv?.success) {
        setLiveTuanVinh(tv)
        setTrackingMessage(
          '✓ Đã lưu tracking và cập nhật Tuấn Vĩnh.'
        )
      } else {
        // Nếu POST chưa trả TV, gọi GET trực tiếp.
        setTrackingMessage(
          'Đã lưu tracking — đang tra lại Tuấn Vĩnh...'
        )

        try {
          tv = await onRefreshTuanVinh({
            ...savedOrder,
            tracking_number: tracking,
            forceTuanVinh: true,
          })

          if (tv?.success) {
            setLiveTuanVinh(tv)
            setTrackingMessage(
              '✓ Đã lưu tracking và cập nhật Tuấn Vĩnh.'
            )
          } else {
            throw new Error(
              'Tuấn Vĩnh chưa trả dữ liệu cho mã này.'
            )
          }
        } catch (refreshError) {
          setTrackingMessage(
            `⚠️ Tracking đã lưu nhưng chưa lấy được Tuấn Vĩnh: ${refreshError.message}`
          )
        }
      }

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
            <div className="modal-product" key={`${item.sku}-${index}`}>
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
              </div>
            </div>
          ))}
        </div>

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
  const [updatedAt, setUpdatedAt] = useState(null)
  const [activeFilter, setActiveFilter] = useState('Tất cả')
  const [search, setSearch] = useState('')
  const [selectedYear, setSelectedYear] = useState(() => {
    try { return localStorage.getItem('samuchan_selected_year') || 'Tất cả' } catch { return 'Tất cả' }
  })
  const [selectedMonth, setSelectedMonth] = useState(() => {
    try { return localStorage.getItem('samuchan_selected_month') || 'Tất cả' } catch { return 'Tất cả' }
  })
  const [selectedDay, setSelectedDay] = useState(() => {
    try { return localStorage.getItem('samuchan_selected_day') || 'Tất cả' } catch { return 'Tất cả' }
  })
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [loading, setLoading] = useState(true)
  const [logisticsLoading, setLogisticsLoading] = useState(false)
  const [error, setError] = useState('')
  const [exchangeRate, setExchangeRate] = useState(() => {
    try { return Number(localStorage.getItem('samuchan_exchange_rate') || 0) } catch { return 0 }
  })

  useEffect(() => {
    try {
      localStorage.setItem('samuchan_selected_year', selectedYear)
      localStorage.setItem('samuchan_selected_month', selectedMonth)
      localStorage.setItem('samuchan_selected_day', selectedDay)
    } catch {}
  }, [selectedYear, selectedMonth, selectedDay])

  const refreshOneTuanVinh = useCallback(async (order) => {
    const tracking = String(order?.tracking_number || '').trim()
    const forceTuanVinh = Boolean(order?.forceTuanVinh)

    if (!tracking) return null
    try {
      const response = await fetch(
        `/api/tuanvinh/track/${encodeURIComponent(tracking)}?force=1`,
        {
          method: 'GET',
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache',
          },
        }
      )

      const payload = await response.json()

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
        payload

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
                status: tv.current_status || item.status,
              }
            : item
        )
      )

      setSelectedOrder((current) =>
        current && current.order_id === order.order_id
          ? {
              ...current,
              tuanvinh: tv,
              status: tv.current_status || current.status,
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

  const enrichTuanVinh = useCallback(async (sourceOrders) => {
    // Lấy logistics cho mọi đơn có tracking. Trước đây điều kiện ngày đặt
    // hàng làm các đơn cũ hơn mốc cutoff không bao giờ nhận được cân nặng và
    // lịch sử, dù API Tuấn Vĩnh đã có dữ liệu.
    const targets = sourceOrders.filter((order) => order.tracking_number)
    if (!targets.length) return

    setLogisticsLoading(true)
    try {
      const unique = [...new Map(targets.map((order) => [String(order.tracking_number), order])).values()]
      const concurrency = 5
      for (let i = 0; i < unique.length; i += concurrency) {
        const batch = unique.slice(i, i + concurrency)
        await Promise.all(batch.map((order) => refreshOneTuanVinh(order)))
      }
    } finally {
      setLogisticsLoading(false)
    }
  }, [refreshOneTuanVinh])

  const loadOrders = useCallback(async () => {
    try {
      setLoading(true); setError('')
      const response = await fetch('/api/taobao/orders', { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || 'Không đọc được dữ liệu Taobao')
      const normalized = normalizeOrders(data)
      setOrders(normalized)
      setUpdatedAt(data.updated_at || null)
      setLoading(false)
      enrichTuanVinh(normalized)
    } catch (err) {
      setError(err.message || 'Không đọc được dữ liệu Taobao')
      setLoading(false)
    }
  }, [enrichTuanVinh])

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
    try { localStorage.setItem('samuchan_exchange_rate', String(rate)) } catch {}
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src={samuchanLogo} alt="SAMUCHAN Gift & Custom" />
        </div>
        <button className="sync-button" type="button" onClick={loadOrders} disabled={loading}><span>↻</span>{loading ? 'Đang đọc...' : logisticsLoading ? 'Đang cập nhật Tuấn Vĩnh...' : 'Cập nhật Taobao'}</button>
      </header>

      <main className="dashboard">
        <section className="page-heading">
          <div><p className="eyebrow">PURCHASES</p><h1>Purchases</h1><p className="heading-description">Quản lý đơn mua hàng Taobao theo ngày và Order ID.</p></div>
          <div className="last-sync"><span className="online-dot" />{orders.length ? `Đã đồng bộ · ${formatTime(updatedAt)}` : 'Chưa có dữ liệu'}</div>
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
                <small>VND / 1 CNY</small>
              </div>
            </div>
          </div>
        </section>

        <section className="vnd-summary-row">
          <div className="summary-card converted-card">
            <div className="summary-icon converted">₫</div>
            <div><span>Tổng tiền Việt Nam</span><strong>{exchangeRate > 0 ? formatVnd(totalVnd) : 'Chưa nhập tỷ giá'}</strong><small className="conversion-note">{exchangeRate > 0 ? `¥${totalCny.toLocaleString('en-US', { minimumFractionDigits: 2 })} × ${exchangeRate.toLocaleString('vi-VN')}` : 'Nhập tỷ giá CNY → VND ở card bên cạnh'}</small></div>
          </div>
        </section>

        <section className="vnd-summary-row shipping-summary-row">
          <div className="summary-card converted-card shipping-summary-card">
            <div className="summary-icon shipping">🚚</div>
            <div><span>Tổng phí vận chuyển</span><strong>{totalShippingVnd > 0 ? formatVnd(totalShippingVnd) : 'Chưa có dữ liệu'}</strong><small className="conversion-note">Tính theo cân nặng Tuấn Vĩnh: 22k / 21k / 20k mỗi kg</small></div>
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

      {
        selectedOrder && (
          <OrderDetailModal
            order={selectedOrder}
            exchangeRate={exchangeRate}
            formatVnd={formatVnd}
            onTrackingSaved={handleTrackingSaved}
            onRefreshTuanVinh={refreshOneTuanVinh}
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
