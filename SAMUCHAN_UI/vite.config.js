import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import http from 'node:http'

const dataFile = resolve(process.env.SAMUCHAN_DATA_FILE || '../data/taobao_orders.json')

function taobaoApiPlugin() {
  return {
    name: 'samuchan-taobao-api',
    configureServer(server) {
      server.middlewares.use('/api/taobao/orders', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; return res.end('Method Not Allowed') }
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        if (!existsSync(dataFile)) {
          res.statusCode = 404
          return res.end(JSON.stringify({ message: `Không tìm thấy ${dataFile}` }))
        }
        createReadStream(dataFile).pipe(res)
      })

      server.middlewares.use('/api/taobao/tracking', (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ message: 'Method Not Allowed' })) }
        if (!existsSync(dataFile)) {
          res.statusCode = 404
          return res.end(JSON.stringify({ message: `Không tìm thấy ${dataFile}` }))
        }

        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          try {
            const input = JSON.parse(body || '{}')
            const orderId = String(input.order_id || '').trim()
            const tracking = String(input.tracking_number || '').trim()
            if (!orderId || !tracking) {
              res.statusCode = 400
              return res.end(JSON.stringify({ message: 'Thiếu order_id hoặc tracking_number' }))
            }

            const payload = JSON.parse(readFileSync(dataFile, 'utf8'))
            const orders = Array.isArray(payload.orders) ? payload.orders : []
            const order = orders.find((item) => String(item.order_id || '') === orderId)
            if (!order) {
              res.statusCode = 404
              return res.end(JSON.stringify({ message: `Không tìm thấy Order ID ${orderId}` }))
            }

            order.tracking_number = tracking
            order.tracking_source = 'manual'
            if (!order.delivered_to_china_at) order.status = 'Đang vận chuyển'
            order.logistics_note = 'Tracking được nhập thủ công trên SAMUCHAN.'
            payload.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, '')
            writeFileSync(dataFile, JSON.stringify(payload, null, 2), 'utf8')

            res.statusCode = 200
            return res.end(JSON.stringify({ ok: true, order }))
          } catch (error) {
            res.statusCode = 500
            return res.end(JSON.stringify({ message: `Không lưu được tracking: ${error.message}` }))
          }
        })
      })
    },
  }
}

// FE chạy ở :5173, Express backend chạy ở :3001. Mọi request /api phải
// được chuyển đến Express, bao gồm /api/tuanvinh/track/:trackingNumber.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
