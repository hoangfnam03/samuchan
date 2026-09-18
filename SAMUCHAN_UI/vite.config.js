import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const dataFile = resolve(process.env.SAMUCHAN_DATA_FILE || '../data/taobao_orders.json')

function taobaoApiPlugin() {
  let syncInProgress = false

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

      // Dev mode must also work when only Vite is running (without Express :3001).
      server.middlewares.use('/api/taobao/sync', (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }))
        }
        if (syncInProgress) {
          res.statusCode = 409
          return res.end(JSON.stringify({ success: false, message: 'Đồng bộ Taobao đang chạy.' }))
        }

        syncInProgress = true
        const projectRoot = resolve(process.cwd(), '..')
        const child = spawn('python', [resolve(projectRoot, 'samuchan.py'), '--sync'], {
          cwd: projectRoot,
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
          },
        })
        let output = ''
        child.stdout.on('data', (chunk) => { output += chunk.toString() })
        child.stderr.on('data', (chunk) => { output += chunk.toString() })
        child.once('error', (error) => {
          syncInProgress = false
          res.statusCode = 500
          res.end(JSON.stringify({ success: false, message: `Không thể chạy samuchan.py: ${error.message}` }))
        })
        child.once('close', () => {
          syncInProgress = false
          if (res.writableEnded) return
          if (child.exitCode !== 0) {
            const detail = output
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .filter((line) => !line.includes('temporary directories cleanup'))
              .filter((line) => !line.includes('<gracefully close'))
              .filter((line) => !line.includes('<kill>') && !line.includes('<will force kill>'))
              .slice(-12)
              .join('\n') || `samuchan.py kết thúc với mã ${child.exitCode}`
            res.statusCode = 500
            return res.end(JSON.stringify({ success: false, message: 'Đồng bộ Taobao thất bại.', detail }))
          }
          try {
            const payload = JSON.parse(readFileSync(dataFile, 'utf8'))
            res.end(JSON.stringify({ success: true, taobao_synced_at: payload.taobao_synced_at || payload.updated_at, orders: Array.isArray(payload.orders) ? payload.orders.length : 0 }))
          } catch (error) {
            res.statusCode = 500
            res.end(JSON.stringify({ success: false, message: error.message }))
          }
        })
      })
    },
  }
}

// FE chạy ở :5173, Express backend chạy ở :3001. Mọi request /api phải
// được chuyển đến Express, bao gồm /api/tuanvinh/track/:trackingNumber.
export default defineConfig({
  // Khi chạy `npm run dev`, Vite tự đọc/ghi dữ liệu Taobao tại máy local.
  // Trước đây plugin này bị khai báo nhưng không được đăng ký, nên request
  // `/api/taobao/orders` bị chuyển sang backend :3001 và có thể nhận về HTML.
  plugins: [react(), taobaoApiPlugin()],
  server: {
    proxy: {
      // Chỉ chuyển tiếp API logistics; hai endpoint /api/taobao/* ở trên
      // được Vite phục vụ trực tiếp từ file dữ liệu local.
      '/api/tuanvinh': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
