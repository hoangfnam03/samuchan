import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { spawn } from 'child_process';

import { scanDirectory } from './fileService.js';

// ============================================================
// SAMUCHAN BACKEND
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;

// ============================================================
// PATH
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '..');

const DATA_DIR = path.join(
  PROJECT_ROOT,
  'data'
);

const TAOBAO_ORDERS_FILE = path.join(
  DATA_DIR,
  'taobao_orders.json'
);

const TUANVINH_SESSION_FILE = path.join(
  DATA_DIR,
  'tuanvinh_session.json'
);

const TUANVINH_CACHE_FILE = path.join(
  DATA_DIR,
  'tuanvinh_cache.json'
);

await fs.mkdir(
  DATA_DIR,
  {
    recursive: true,
  }
);

// ============================================================
// TUẤN VĨNH
// ============================================================

const TUANVINH_BASE =
  'https://ordertrungviettuanvinh.com';

const TUANVINH_DECLARES =
  `${TUANVINH_BASE}/thanh-vien/declares`;

const CACHE_TTL =
  10 * 60 * 1000;

// ============================================================
// SESSION LOCK
// ============================================================

let sessionLock =
  Promise.resolve();

function withSessionLock(fn) {
  const next =
    sessionLock.then(
      fn,
      fn
    );

  sessionLock =
    next.catch(
      () => {}
    );

  return next;
}

// ============================================================
// TEXT
// ============================================================

function cleanText(value) {
  return String(
    value ?? ''
  )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}

// ============================================================
// TRACKING CLEAN
// ============================================================

function cleanTracking(value) {
  let tracking =
    cleanText(value);

  // Không cho phép UI gửi:
  // 79029948397800 (đã sửa tay)
  //
  // Nếu chẳng may có thì lấy phần trước dấu (
  tracking =
    tracking
      .replace(
        /\s*\(.*?\)\s*$/g,
        ''
      )
      .trim();

  // Chỉ lấy chuỗi tracking đầu tiên
  // nếu có khoảng trắng thừa
  const match =
    tracking.match(
      /[A-Za-z0-9][A-Za-z0-9._-]*/
    );

  return match
    ? match[0]
    : tracking;
}

// ============================================================
// JSON
// ============================================================

async function readJsonSafe(
  file,
  fallback
) {
  try {
    const text =
      await fs.readFile(
        file,
        'utf8'
      );

    return JSON.parse(
      text
    );
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(
  file,
  data
) {
  await fs.writeFile(
    file,
    JSON.stringify(
      data,
      null,
      2
    ),
    'utf8'
  );
}

// ============================================================
// TAOBAO ORDERS
// ============================================================

async function readTaobaoOrders() {
  const payload =
    await readJsonSafe(
      TAOBAO_ORDERS_FILE,
      {
        updated_at:
          null,

        orders: [],
      }
    );

  if (
    Array.isArray(payload)
  ) {
    return {
      updated_at:
        null,

      orders:
        payload,
    };
  }

  return {
    updated_at:
      payload?.updated_at ||
      null,

    taobao_synced_at:
      payload?.taobao_synced_at ||
      null,

    initial_sync_completed:
      payload?.initial_sync_completed === true,

    orders:
      Array.isArray(
        payload?.orders
      )
        ? payload.orders
        : [],
  };
}

async function saveTaobaoOrders(
  payload
) {
  await writeJsonSafe(
    TAOBAO_ORDERS_FILE,
    {
      updated_at:
        new Date().toISOString(),

      // Không đổi mốc đồng bộ Taobao khi chỉ lưu logistics Tuấn Vĩnh.
      taobao_synced_at:
        payload?.taobao_synced_at ||
        null,

      initial_sync_completed:
        payload?.initial_sync_completed === true,

      orders:
        Array.isArray(
          payload?.orders
        )
          ? payload.orders
          : [],
    }
  );
}

// ============================================================
// TUẤN VĨNH SESSION
// ============================================================

async function readTuanVinhSession() {
  return readJsonSafe(
    TUANVINH_SESSION_FILE,
    {
      cookies: [],
      savedAt: null,
    }
  );
}

async function saveTuanVinhSession(
  context
) {
  const cookies =
    await context.cookies();

  await writeJsonSafe(
    TUANVINH_SESSION_FILE,
    {
      cookies,
      savedAt:
        new Date().toISOString(),
    }
  );

  console.log(
    `[TUẤN VĨNH] Đã lưu ${cookies.length} cookies.`
  );

  return cookies;
}

async function hasTuanVinhSession() {
  try {
    const session =
      await readTuanVinhSession();

    return (
      Array.isArray(
        session.cookies
      ) &&
      session.cookies.length >
        0
    );
  } catch {
    return false;
  }
}

// ============================================================
// BROWSER
// ============================================================

async function createTuanVinhBrowser() {
  const session =
    await readTuanVinhSession();

  const browser =
    await chromium.launch({
      headless: true,
    });

  const context =
    await browser.newContext({
      locale:
        'vi-VN',

      viewport: {
        width: 1440,
        height: 1000,
      },

      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    });

  if (
    Array.isArray(
      session.cookies
    ) &&
    session.cookies.length
  ) {
    try {
      await context.addCookies(
        session.cookies
      );

      console.log(
        `[TUẤN VĨNH] Loaded ${session.cookies.length} cookies.`
      );

    } catch (error) {
      console.log(
        '[TUẤN VĨNH] Cookie error:',
        error.message
      );
    }
  }

  return {
    browser,
    context,
  };
}

// ============================================================
// LOGIN
// ============================================================

app.post(
  '/api/tuanvinh/login',
  async (
    req,
    res
  ) => {
    try {
      const result =
        await withSessionLock(
          async () => {
            const browser =
              await chromium.launch({
                headless:
                  false,
              });

            const context =
              await browser.newContext({
                locale:
                  'vi-VN',

                viewport: {
                  width: 1440,
                  height: 1000,
                },
              });

            const page =
              await context.newPage();

            await page.goto(
              TUANVINH_DECLARES,
              {
                waitUntil:
                  'domcontentloaded',

                timeout:
                  60000,
              }
            );

            console.log('');
            console.log(
              '================================================'
            );
            console.log(
              '       ĐĂNG NHẬP TUẤN VĨNH'
            );
            console.log(
              '================================================'
            );
            console.log(
              'Chrome đã mở.'
            );
            console.log(
              'Hãy đăng nhập Tuấn Vĩnh bằng tay.'
            );
            console.log(
              'Không nhập password vào SAMUCHAN.'
            );
            console.log(
              '================================================'
            );
            console.log('');

            // 5 phút để login
            await page.waitForTimeout(
              300000
            );

            const cookies =
              await saveTuanVinhSession(
                context
              );

            await browser.close();

            return {
              success:
                true,

              loggedIn:
                true,

              cookieCount:
                cookies.length,

              savedAt:
                new Date().toISOString(),
            };
          }
        );

      res.json(
        result
      );

    } catch (error) {
      console.error(
        '[TUẤN VĨNH LOGIN ERROR]',
        error
      );

      res.status(
        500
      ).json({
        success:
          false,

        message:
          error.message,
      });
    }
  }
);

// ============================================================
// SESSION STATUS
// ============================================================

app.get(
  '/api/tuanvinh/session',
  async (
    req,
    res
  ) => {
    try {
      const loggedIn =
        await hasTuanVinhSession();

      const session =
        await readTuanVinhSession();

      res.json({
        success:
          true,

        loggedIn,

        savedAt:
          session.savedAt ||
          null,
      });

    } catch (error) {
      res.status(
        500
      ).json({
        success:
          false,

        message:
          error.message,
      });
    }
  }
);

// ============================================================
// FIND TRACKING BLOCK
// ============================================================

function findTrackingBlock(
  $,
  tracking
) {
  let block =
    null;

  // Cấu trúc thật của Tuấn Vĩnh:
  //
  // <div class="mb-10 space-y-5">
  //   Mã vận đơn: XXXXX
  //   Cân nặng: 1.52 kg
  //   ...
  // </div>

  $('.mb-10.space-y-5').each(
    (_, element) => {
      if (block) {
        return;
      }

      const $candidate =
        $(element);

      const text =
        cleanText(
          $candidate.text()
        );

      if (
        text.includes(
          'Mã vận đơn'
        ) &&
        text.includes(
          tracking
        )
      ) {
        block =
          $candidate;
      }
    }
  );

  // Fallback tìm bằng text
  if (!block) {
    $('body *').each(
      (_, element) => {
        if (block) {
          return;
        }

        const $element =
          $(element);

        const text =
          cleanText(
            $element.text()
          );

        if (
          text.includes(
            'Mã vận đơn'
          ) &&
          text.includes(
            tracking
          )
        ) {
          const parent =
            $element.closest(
              '.mb-10.space-y-5'
            );

          if (
            parent.length
          ) {
            block =
              parent;
          }
        }
      }
    );
  }

  return block;
}

// ============================================================
// PARSE TRACKING
// ============================================================

function parseTracking(
  $,
  block,
  fallback
) {
  let value =
    fallback;

  block
    .find('div')
    .each(
      (_, element) => {
        const text =
          cleanText(
            $(element).text()
          );

        if (
          text.startsWith(
            'Mã vận đơn:'
          )
        ) {
          const extracted =
            cleanTracking(
              text.replace(
                'Mã vận đơn:',
                ''
              )
            );

          if (
            extracted
          ) {
            value =
              extracted;
          }
        }
      }
    );

  return value;
}

// ============================================================
// PARSE WEIGHT
// ============================================================

function parseWeight(
  $,
  block
) {
  let weight =
    null;

  block
    .find('div')
    .each(
      (_, element) => {
        if (
          weight !==
          null
        ) {
          return;
        }

        const text =
          cleanText(
            $(element).text()
          );

        if (
          !text.startsWith(
            'Cân nặng:'
          )
        ) {
          return;
        }

        const match =
          text.match(
            /Cân nặng:\s*([\d.,]+)\s*kg/i
          );

        if (
          match
        ) {
          weight =
            Number(
              match[1]
                .replace(
                  ',',
                  '.'
                )
            );
        }
      }
    );

  return weight;
}

// ============================================================
// PARSE CURRENT STATUS
// ============================================================

function parseCurrentStatus(
  $,
  block
) {
  let status =
    null;

  // ----------------------------------------------------------
  // Ưu tiên badge:
  //
  // <span class="p-2 rounded-lg bg-orange-500 text-white">
  //    Nhập kho Việt Nam
  // </span>
  // ----------------------------------------------------------

  block
    .find('span')
    .each(
      (_, element) => {
        if (status) {
          return;
        }

        const $span =
          $(element);

        const className =
          String(
            $span.attr(
              'class'
            ) || ''
          );

        const text =
          cleanText(
            $span.text()
          );

        if (
          !text
        ) {
          return;
        }

        if (
          className.includes(
            'rounded-lg'
          ) &&
          className.includes(
            'text-white'
          )
        ) {
          status =
            text;
        }
      }
    );

  // ----------------------------------------------------------
  // Fallback: tìm sau chữ Trạng thái
  // ----------------------------------------------------------

  if (!status) {
    block
      .find('*')
      .each(
        (_, element) => {
          if (status) {
            return;
          }

          const $element =
            $(element);

          const text =
            cleanText(
              $element.text()
            );

          if (
            text ===
            'Trạng thái:'
          ) {
            const nextSpan =
              $element
                .find(
                  'span'
                )
                .first();

            const value =
              cleanText(
                nextSpan.text()
              );

            if (
              value
            ) {
              status =
                value;
            }
          }
        }
      );
  }

  // ----------------------------------------------------------
  // Fallback bằng known statuses
  // ----------------------------------------------------------

  if (!status) {
    const statuses = [
      'Nhập kho Việt Nam',
      'Xuất kho Việt Nam',
      'Nhập kho Trung Quốc',
      'Đang vận chuyển',
      'Đã giao',
      'Đã nhận hàng',
    ];

    const fullText =
      cleanText(
        block.text()
      );

    for (
      const item
      of statuses
    ) {
      if (
        fullText.includes(
          item
        )
      ) {
        status =
          item;

        break;
      }
    }
  }

  return status;
}

const VIETNAM_EXIT_STATUS = 'Đã xuất kho Việt Nam';

function hasVietnamExit(data) {
  const history = Array.isArray(data) ? data : data?.history;
  const currentStatus = Array.isArray(data)
    ? ''
    : String(data?.current_status || data?.status || '');

  if (currentStatus.toLowerCase().includes('xuất kho việt nam')) return true;

  return Array.isArray(history) && history.some((item) => {
    const text = typeof item === 'string'
      ? item
      : String(item?.status || item?.name || item?.text || '');

    return text.toLowerCase().includes('xuất kho việt nam');
  });
}

function normalizeTuanVinhStatus(result) {
  if (!result || !hasVietnamExit(result)) return result;

  return {
    ...result,
    current_status: VIETNAM_EXIT_STATUS,
  };
}

// ============================================================
// PARSE HISTORY
// ============================================================

function parseHistory(
  $,
  block
) {
  const history =
    [];

  // Cấu trúc thật:
  //
  // <ol>
  //   <li>
  //      <time>2026-09-04 ...</time>
  //      <p>Nhập kho Trung Quốc</p>
  //   </li>
  // </ol>

  block
    .find('ol li')
    .each(
      (_, element) => {
        const $li =
          $(element);

        const time =
          cleanText(
            $li
              .find(
                'time'
              )
              .first()
              .text()
          );

        const status =
          cleanText(
            $li
              .find(
                'p'
              )
              .first()
              .text()
          );

        if (
          time &&
          status
        ) {
          history.push({
            time,
            status,
          });
        }
      }
    );

  // Fallback
  if (
    history.length ===
    0
  ) {
    block
      .find('li')
      .each(
        (_, element) => {
          const $li =
            $(element);

          const time =
            cleanText(
              $li
                .find(
                  'time'
                )
                .first()
                .text()
            );

          const status =
            cleanText(
              $li
                .find(
                  'p'
                )
                .first()
                .text()
            );

          if (
            time &&
            status
          ) {
            history.push({
              time,
              status,
            });
          }
        }
      );
  }

  return history;
}

// ============================================================
// PARSE FULL TUẤN VĨNH
// ============================================================

function parseTuanVinhHtml(
  html,
  requestedTracking
) {
  const $ =
    cheerio.load(
      html
    );

  const tracking =
    cleanTracking(
      requestedTracking
    );

  const result = {
    success:
      false,

    tracking_number:
      tracking,

    weight_kg:
      null,

    current_status:
      null,

    history: [],

    message:
      null,
  };

  // ----------------------------------------------------------
  // FIND BLOCK
  // ----------------------------------------------------------

  const block =
    findTrackingBlock(
      $,
      tracking
    );

  if (!block) {
    result.message =
      'Không tìm thấy block vận đơn trên trang Tuấn Vĩnh.';

    return result;
  }

  // ----------------------------------------------------------
  // DATA
  // ----------------------------------------------------------

  result.tracking_number =
    parseTracking(
      $,
      block,
      tracking
    );

  result.weight_kg =
    parseWeight(
      $,
      block
    );

  result.current_status =
    parseCurrentStatus(
      $,
      block
    );

  result.history =
    parseHistory(
      $,
      block
    );

  result.current_status =
    normalizeTuanVinhStatus(result).current_status;

  // ----------------------------------------------------------
  // SUCCESS
  // ----------------------------------------------------------

  if (
    result.weight_kg !==
      null ||
    result.current_status ||
    result.history.length >
      0
  ) {
    result.success =
      true;

    result.message =
      'Đã lấy dữ liệu Tuấn Vĩnh.';
  } else {
    result.message =
      'Tìm thấy vận đơn nhưng không lấy được dữ liệu chi tiết.';
  }

  // ----------------------------------------------------------
  // DEBUG
  // ----------------------------------------------------------

  console.log('');
  console.log(
    '================================================'
  );
  console.log(
    '[TUẤN VĨNH PARSE RESULT]'
  );
  console.log(
    `Tracking      : ${result.tracking_number}`
  );
  console.log(
    `Weight        : ${result.weight_kg}`
  );
  console.log(
    `Current status: ${result.current_status}`
  );
  console.log(
    `History count : ${result.history.length}`
  );

  result.history.forEach(
    (item, index) => {
      console.log(
        `  ${index + 1}. ${item.time} -> ${item.status}`
      );
    }
  );

  console.log(
    '================================================'
  );
  console.log('');

  return result;
}

// ============================================================
// CACHE
// ============================================================

async function readCache() {
  return readJsonSafe(
    TUANVINH_CACHE_FILE,
    {}
  );
}

async function writeCache(
  cache
) {
  await writeJsonSafe(
    TUANVINH_CACHE_FILE,
    cache
  );
}

async function deleteCache(
  tracking
) {
  const cache =
    await readCache();

  delete cache[
    tracking
  ];

  await writeCache(
    cache
  );

  console.log(
    `[TUẤN VĨNH] Đã xóa cache: ${tracking}`
  );
}

// ============================================================
// TRACK TUẤN VĨNH
// ============================================================

async function trackTuanVinh(
  trackingNumber,
  options = {}
) {
  const tracking =
    cleanTracking(
      trackingNumber
    );

  const forceRefresh =
    Boolean(
      options.forceRefresh
    );

  if (!tracking) {
    throw new Error(
      'Tracking number rỗng.'
    );
  }

  console.log('');
  console.log(
    '================================================'
  );
  console.log(
    '[TUẤN VĨNH LOOKUP]'
  );
  console.log(
    `Tracking: ${tracking}`
  );
  console.log(
    `Force refresh: ${forceRefresh}`
  );
  console.log(
    '================================================'
  );

  // ==========================================================
  // CACHE
  // ==========================================================

  if (
    !forceRefresh
  ) {
    const cache =
      await readCache();

    const cached =
      cache[
        tracking
      ];

    if (
      cached?.fetched_at
    ) {
      const fetched =
        new Date(
          cached.fetched_at
        ).getTime();

      const age =
        Date.now() -
        fetched;

      if (
        age >= 0 &&
        age <
          CACHE_TTL
      ) {
        console.log(
          `[TUẤN VĨNH] ✓ Dùng cache: ${tracking}`
        );

        return {
          ...normalizeTuanVinhStatus(cached),
          cached: true,
        };
      }
    }
  }

  // ==========================================================
  // SESSION
  // ==========================================================

  const sessionExists =
    await hasTuanVinhSession();

  if (
    !sessionExists
  ) {
    throw new Error(
      'Chưa có session Tuấn Vĩnh. Hãy đăng nhập Tuấn Vĩnh trước.'
    );
  }

  // ==========================================================
  // BROWSER
  // ==========================================================

  const {
    browser,
    context,
  } =
    await createTuanVinhBrowser();

  try {
    const page =
      await context.newPage();

    const url =
      `${TUANVINH_DECLARES}?keyword=${encodeURIComponent(
        tracking
      )}`;

    console.log(
      `[TUẤN VĨNH] GET ${url}`
    );

    const response =
      await page.goto(
        url,
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            60000,
        }
      );

    if (!response) {
      throw new Error(
        'Không nhận được response từ Tuấn Vĩnh.'
      );
    }

    const httpStatus =
      response.status();

    console.log(
      `[TUẤN VĨNH] HTTP ${httpStatus}`
    );

    // ========================================================
    // SESSION EXPIRED
    // ========================================================

    if (
      httpStatus ===
        401 ||
      httpStatus ===
        403
    ) {
      throw new Error(
        `Session Tuấn Vĩnh hết hạn. HTTP ${httpStatus}.`
      );
    }

    // ========================================================
    // HTML
    // ========================================================

    const html =
      await page.content();

    console.log(
      `[TUẤN VĨNH] HTML length: ${html.length}`
    );

    console.log(
      `[TUẤN VĨNH] Có tracking trong HTML: ${html.includes(
        tracking
      )}`
    );

    // ========================================================
    // LOGIN CHECK
    // ========================================================

    const bodyText =
      cleanText(
        await page
          .locator('body')
          .innerText()
          .catch(
            () => ''
          )
      );

    const looksLikeLogin =
      bodyText.includes(
        'Đăng nhập'
      ) &&
      (
        bodyText.includes(
          'Tài khoản'
        ) ||
        bodyText.includes(
          'Mật khẩu'
        )
      );

    if (
      looksLikeLogin
    ) {
      throw new Error(
        'Session Tuấn Vĩnh không còn đăng nhập. Hãy đăng nhập lại.'
      );
    }

    // ========================================================
    // PARSE
    // ========================================================

    const parsed =
      parseTuanVinhHtml(
        html,
        tracking
      );

    // ========================================================
    // NOT FOUND
    // ========================================================

    if (
      !parsed.success
    ) {
      const result = {
        success:
          false,

        tracking_number:
          tracking,

        weight_kg:
          null,

        current_status:
          null,

        history: [],

        message:
          parsed.message ||
          'Không tìm thấy dữ liệu Tuấn Vĩnh.',

        fetched_at:
          new Date().toISOString(),

        cached:
          false,
      };

      const cache =
        await readCache();

      cache[
        tracking
      ] =
        result;

      await writeCache(
        cache
      );

      return result;
    }

    // ========================================================
    // SUCCESS RESULT
    // ========================================================

    const result = {
      success:
        true,

      tracking_number:
        cleanTracking(
          parsed.tracking_number ||
          tracking
        ),

      weight_kg:
        parsed.weight_kg,

      current_status:
        parsed.current_status,

      history:
        parsed.history,

      message:
        parsed.message,

      fetched_at:
        new Date().toISOString(),

      cached:
        false,
    };

    // ========================================================
    // SAVE CACHE
    // ========================================================

    const cache =
      await readCache();

    cache[
      tracking
    ] =
      result;

    await writeCache(
      cache
    );

    // ========================================================
    // REFRESH SESSION COOKIES
    // ========================================================

    try {
      await saveTuanVinhSession(
        context
      );
    } catch (
      error
    ) {
      console.warn(
        '[TUẤN VĨNH] Không save cookies:',
        error.message
      );
    }

    return result;

  } finally {
    await browser.close();
  }
}

// ============================================================
// SAVE TUẤN VĨNH RESULT TO ORDER
// ============================================================

async function saveTuanVinhToOrder(
  trackingNumber,
  tv
) {
  const tracking =
    cleanTracking(
      trackingNumber
    );

  if (
    !tracking ||
    !tv
  ) {
    return false;
  }

  const hasExitedVietnam = hasVietnamExit(tv);

  const payload =
    await readTaobaoOrders();

  let changed =
    false;

  payload.orders =
    payload.orders.map(
      (order) => {
        const orderTracking =
          cleanTracking(
            order?.tracking_number
          );

        if (
          orderTracking !==
          tracking
        ) {
          return order;
        }

        changed =
          true;

        const updated = {
          ...order,

          tracking_number:
            tracking,

          tuanvinh:
            tv,

          tuanvinh_locked:
            order.tuanvinh_locked === true ||
            hasExitedVietnam,
        };

        if (hasExitedVietnam || tv.current_status) {
          updated.status = hasExitedVietnam
            ? VIETNAM_EXIT_STATUS
            : tv.current_status;
        }

        return updated;
      }
    );

  if (
    changed
  ) {
    await saveTaobaoOrders(
      payload
    );

    console.log(
      `[TUẤN VĨNH] ✓ Đã ghi dữ liệu vào taobao_orders.json: ${tracking}`
    );

    if (hasExitedVietnam) {
      console.log(
        `[TUẤN VĨNH] 🔒 Tracking ${tracking} đã Xuất kho Việt Nam → khóa tự động refresh`
      );
    }
  } else {
    console.log(
      `[TUẤN VĨNH] ⚠ Không tìm thấy order có tracking: ${tracking}`
    );
  }

  return changed;
}
// ============================================================
// GET ONE TRACKING
// ============================================================

app.get(
  '/api/tuanvinh/track/:trackingNumber',
  async (
    req,
    res
  ) => {
    try {
      const tracking =
        cleanTracking(
          req.params.trackingNumber
        );

      if (!tracking) {
        return res.status(
          400
        ).json({
          success:
            false,

          message:
            'Tracking number rỗng.',
        });
      }

      const force =
        req.query.force ===
          '1' ||
        req.query.force ===
          'true';

      console.log('');
      console.log(
        '################################################'
      );
      console.log(
        '[API] TUẤN VĨNH TRACK'
      );
      console.log(
        `Tracking: ${tracking}`
      );
      console.log(
        `Force: ${force}`
      );
      console.log(
        '################################################'
      );

      const result =
        await trackTuanVinh(
          tracking,
          {
            forceRefresh:
              force,
          }
        );

      // Chỉ lưu kết quả thành công
      if (
        result?.success
      ) {
        await saveTuanVinhToOrder(
          tracking,
          result
        );
      }

      res.json(
        result
      );

    } catch (error) {
      console.error(
        '[API TUẤN VĨNH ERROR]',
        error
      );

      res.status(
        500
      ).json({
        success:
          false,

        tracking_number:
          cleanTracking(
            req.params.trackingNumber
          ),

        message:
          error.message,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// TRACK MANY
// ============================================================

app.post(
  '/api/tuanvinh/track',
  async (
    req,
    res
  ) => {
    try {
      const numbers =
        Array.isArray(
          req.body?.tracking_numbers
        )
          ? req.body
              .tracking_numbers
          : [];

      const unique =
        [
          ...new Set(
            numbers
              .map(
                cleanTracking
              )
              .filter(
                Boolean
              )
          ),
        ];

      const results =
        {};

      for (
        const tracking
        of unique
      ) {
        try {
          const result =
            await trackTuanVinh(
              tracking,
              {
                forceRefresh:
                  false,
              }
            );

          results[
            tracking
          ] =
            result;

          if (
            result?.success
          ) {
            await saveTuanVinhToOrder(
              tracking,
              result
            );
          }

        } catch (
          error
        ) {
          results[
            tracking
          ] = {
            success:
              false,

            tracking_number:
              tracking,

            message:
              error.message,
          };
        }
      }

      res.json({
        success:
          true,

        count:
          unique.length,

        results,
      });

    } catch (error) {
      console.error(
        '[TRACK MANY ERROR]',
        error
      );

      res.status(
        500
      ).json({
        success:
          false,

        message:
          error.message,
      });
    }
  }
);

// ============================================================
// GET TAOBAO ORDERS
// ============================================================
// ============================================================
// TAOBAO SYNC + GET TAOBAO ORDERS
// ============================================================

let taobaoSyncInProgress = false;


// ============================================================
// PYTHON COMMAND
// ============================================================

function getPythonCommand() {

  const venvPython = path.join(
    PROJECT_ROOT,
    '.venv',
    'Scripts',
    'python.exe'
  );

  return venvPython;
}


// ============================================================
// CLEAN PYTHON OUTPUT
// ============================================================

function summarizePythonOutput(output) {

  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

    .filter(
      (line) =>
        !line.includes('temporary directories cleanup')
    )

    .filter(
      (line) =>
        !line.includes('<gracefully close end>')
    )

    .filter(
      (line) =>
        !line.includes('<gracefully close start>')
    )

    .filter(
      (line) =>
        !line.includes('<kill>')
    )

    .filter(
      (line) =>
        !line.includes('<will force kill>')
    )

    .slice(-12)

    .join('\n');
}


// ============================================================
// RUN TAOBAO PYTHON SYNC
// ============================================================

function runTaobaoPythonSync() {

  return new Promise(
    (resolve, reject) => {

      const script =
        path.join(
          PROJECT_ROOT,
          'samuchan.py'
        );

      const venvPython =
        getPythonCommand();


      // --------------------------------------------------------
      // Ưu tiên Python trong .venv
      // Nếu không có thì dùng python trong PATH
      // --------------------------------------------------------

      const command =
        existsSync(venvPython)
          ? venvPython
          : 'python';

      // Railway phải chạy thẳng chế độ non-interactive. Nếu chạy menu mặc
      // định rồi chờ gửi phím "1", child process có thể không nhận prompt
      // đúng lúc và Chromium cũng bị khởi động nhầm ở chế độ có giao diện.
      const commandArgs = [
        script,
        '--sync',
      ];


      console.log('');
      console.log(
        '################################################'
      );

      console.log(
        '[API] TAOBAO SYNC'
      );

      console.log(
        '################################################'
      );

      console.log(
        `[TAOBAO SYNC] Script: ${script}`
      );

      console.log(
        `[TAOBAO SYNC] Python: ${command}`
      );

      console.log('');


      let child;


      // --------------------------------------------------------
      // START PYTHON
      // --------------------------------------------------------

      try {

        child =
          spawn(
            command,
            commandArgs,
            {
              cwd:
                PROJECT_ROOT,

              windowsHide:
                false,

              stdio:
                [
                  'pipe',
                  'pipe',
                  'pipe'
                ],

              env:
                {
                  ...process.env,

                  PYTHONIOENCODING:
                    'utf-8'
                }
            }
          );

      } catch (error) {

        reject(error);

        return;
      }


      let output = '';

      let settled = false;

      let closeTimer = null;


      // --------------------------------------------------------
      // FINISH PROMISE ONCE
      // --------------------------------------------------------

      const finish =
        (fn, value) => {

          if (settled) {
            return;
          }

          settled = true;


          if (closeTimer) {

            clearTimeout(
              closeTimer
            );

          }


          fn(value);
        };


      // --------------------------------------------------------
      // HANDLE PYTHON OUTPUT
      // --------------------------------------------------------

      const handleChunk =
        (chunk) => {

          const text =
            chunk.toString();

          output += text;


          // Hiện log Python trên PowerShell
          process.stdout.write(
            text
          );


          // ----------------------------------------------------
          // PYTHON MENU
          // ----------------------------------------------------
          //
          // samuchan.py hiện tại:
          //
          // 1. Chạy lấy dữ liệu Taobao
          // 2. Kiểm tra profile
          // 3. Thoát
          //
          // ----------------------------------------------------

          if (
            /Chọn:\s*$/.test(text)
          ) {

            try {

              child.stdin.write(
                '1\n'
              );

              console.log(
                '[TAOBAO SYNC] → Chọn 1: Chạy lấy dữ liệu Taobao.'
              );

            } catch {}

          }


          // ----------------------------------------------------
          // TRACKING THIẾU
          // ----------------------------------------------------
          //
          // Tracking thiếu sẽ được xử lý bằng UI SAMUCHAN.
          // Không cần Python hỏi thủ công nữa.
          //
          // ----------------------------------------------------

          if (
            /Tracking number \(ENTER để bỏ qua\):\s*$/.test(
              text
            )
          ) {

            try {

              child.stdin.write(
                '\n'
              );

            } catch {}

          }


          // ----------------------------------------------------
          // ĐÓNG BROWSER
          // ----------------------------------------------------

          if (
            /ENTER để đóng browser\.\.\.\s*$/.test(
              text
            )
          ) {

            try {

              child.stdin.write(
                '\n'
              );

            } catch {}

          }

        };


      child.stdout.on(
        'data',
        handleChunk
      );

      child.stderr.on(
        'data',
        handleChunk
      );


      // --------------------------------------------------------
      // PROCESS ERROR
      // --------------------------------------------------------

      child.once(
        'error',
        (error) => {

          finish(
            reject,
            error
          );

        }
      );


      // --------------------------------------------------------
      // PROCESS CLOSE
      // --------------------------------------------------------

      child.once(
        'close',
        async (
          code,
          signal
        ) => {

          // ----------------------------------------------------
          // PYTHON FAILED
          // ----------------------------------------------------

          if (
            code !== 0
          ) {

            const detail =
              summarizePythonOutput(
                output
              );


            finish(
              reject,

              new Error(
                `samuchan.py kết thúc không thành công. ` +
                `Code=${code ?? 'null'} ` +
                `Signal=${signal || 'none'}` +
                (
                  detail
                    ? `\n${detail}`
                    : ''
                )
              )
            );

            return;
          }


          // ----------------------------------------------------
          // PYTHON SUCCESS
          // ----------------------------------------------------

          try {

            const payload =
              await readTaobaoOrders();


            const syncedAt =
              new Date().toISOString();


            // --------------------------------------------------
            // Ghi riêng thời điểm đồng bộ Taobao
            // --------------------------------------------------

            payload.taobao_synced_at =
              syncedAt;


            await saveTaobaoOrders(
              payload
            );


            console.log('');

            console.log(
              '================================================'
            );

            console.log(
              '[TAOBAO SYNC] ✓ Đồng bộ Taobao thành công'
            );

            console.log(
              `[TAOBAO SYNC] Orders: ${payload.orders.length}`
            );

            console.log(
              `[TAOBAO SYNC] Synced at: ${syncedAt}`
            );

            console.log(
              '================================================'
            );

            console.log('');


            finish(
              resolve,
              {
                success:
                  true,

                taobao_synced_at:
                  syncedAt,

                orders:
                  payload.orders.length,

                output
              }
            );

          } catch (error) {

            finish(
              reject,
              error
            );

          }

        }
      );


      // --------------------------------------------------------
      // TIMEOUT 15 PHÚT
      // --------------------------------------------------------

      closeTimer =
        setTimeout(
          () => {

            try {

              child.kill();

            } catch {}


            finish(
              reject,

              new Error(
                'Đồng bộ Taobao quá 15 phút nên backend đã dừng tiến trình.'
              )
            );

          },

          15 * 60 * 1000
        );

    }
  );

}


// ============================================================
// POST /api/taobao/sync
// ============================================================

app.post(
  '/api/taobao/sync',
  async (
    req,
    res
  ) => {

    // --------------------------------------------------------
    // Không cho chạy 2 sync cùng lúc
    // --------------------------------------------------------

    if (
      taobaoSyncInProgress
    ) {

      return res.status(
        409
      ).json({

        success:
          false,

        message:
          'Đồng bộ Taobao đang chạy. Không chạy thêm lần nữa.'

      });

    }


    taobaoSyncInProgress =
      true;


    try {

      console.log('');

      console.log(
        '################################################'
      );

      console.log(
        '[API] BẮT ĐẦU ĐỒNG BỘ TAOBAO'
      );

      console.log(
        '################################################'
      );


      const result =
        await runTaobaoPythonSync();


      // ------------------------------------------------------
      // Đọc lại dữ liệu sau khi Python hoàn thành
      // ------------------------------------------------------

      const payload =
        await readTaobaoOrders();


      return res.json({

        success:
          true,

        taobao_synced_at:
          payload.taobao_synced_at ||
          result.taobao_synced_at,

        updated_at:
          payload.updated_at,

        orders:
          payload.orders.length

      });


    } catch (error) {

      console.error(
        '[TAOBAO SYNC ERROR]',
        error
      );


      return res.status(
        500
      ).json({

        success:
          false,

        message:
          error.message

      });


    } finally {

      taobaoSyncInProgress =
        false;

    }

  }
);


// ============================================================
// GET TAOBAO SYNC STATUS
// ============================================================

app.get(
  '/api/taobao/sync-status',
  async (
    req,
    res
  ) => {

    try {

      const payload =
        await readTaobaoOrders();


      res.json({

        success:
          true,

        running:
          taobaoSyncInProgress,

        updated_at:
          payload.updated_at,

        taobao_synced_at:
          payload.taobao_synced_at ||
          null,

        orders:
          payload.orders.length

      });


    } catch (error) {

      res.status(
        500
      ).json({

        success:
          false,

        message:
          error.message

      });

    }

  }
);


// ============================================================
// GET TAOBAO ORDERS
// ============================================================

app.get(
  '/api/taobao/orders',
  async (
    req,
    res
  ) => {

    try {

      const payload =
        await readTaobaoOrders();


      res.json({

        success:
          true,

        updated_at:
          payload.updated_at,

        taobao_synced_at:
          payload.taobao_synced_at,

        orders:
          payload.orders

      });


    } catch (error) {

      console.error(
        '[TAOBAO ORDERS ERROR]',
        error
      );


      res.status(
        500
      ).json({

        success:
          false,

        message:
          error.message

      });

    }

  }
);

// ============================================================
// SAVE / EDIT TRACKING
// ============================================================

app.post(
  '/api/taobao/tracking',
  async (
    req,
    res
  ) => {
    try {
      const orderId =
        cleanText(
          req.body?.order_id
        );

      const tracking =
        cleanTracking(
          req.body?.tracking_number
        );

      if (!orderId) {
        return res.status(
          400
        ).json({
          success:
            false,

          message:
            'Order ID rỗng.',
        });
      }

      if (!tracking) {
        return res.status(
          400
        ).json({
          success:
            false,

          message:
            'Tracking number rỗng.',
        });
      }

      console.log('');
      console.log(
        '################################################'
      );
      console.log(
        '[API] SAVE TRACKING'
      );
      console.log(
        `Order ID: ${orderId}`
      );
      console.log(
        `Tracking: ${tracking}`
      );
      console.log(
        '################################################'
      );

      // ========================================================
      // READ ORDERS
      // ========================================================

      const payload =
        await readTaobaoOrders();

      const index =
        payload.orders.findIndex(
          (order) =>
            cleanText(
              order?.order_id
            ) ===
            orderId
        );

      if (
        index ===
        -1
      ) {
        return res.status(
          404
        ).json({
          success:
            false,

          message:
            `Không tìm thấy Order ID ${orderId}`,
        });
      }

      // ========================================================
      // UPDATE TRACKING
      // ========================================================

      let order = {
        ...payload.orders[
          index
        ],

        tracking_number:
          tracking,

        tracking_source:
          'manual',

        logistics_note:
          'Tracking được chỉnh thủ công trên SAMUCHAN.',
      };

      // ========================================================
      // CHI LUU TRACKING
      // ========================================================

      let tuanvinh =
        order.tuanvinh ||
        null;

      // Neu doi sang tracking khac thi bo du lieu Tuan Vinh cu de tranh
      // hien thi lich su cua ma van don truoc do. Nguoi dung se bam update
      // rieng khi muon lay trang thai Tuan Vinh moi nhat.
      const previousTracking =
        cleanTracking(
          payload.orders[index]?.tracking_number
        );

      if (
        previousTracking &&
        previousTracking !== tracking
      ) {
        delete order.tuanvinh;
        delete order.tuanvinh_locked;
        tuanvinh = null;
      }

      // ========================================================
      // SAVE ORDER
      // ========================================================

      payload.orders[
        index
      ] =
        order;

      await saveTaobaoOrders(
        payload
      );

      console.log(
        '[SAVE TRACKING] ✓ Đã lưu taobao_orders.json'
      );

      // ========================================================
      // RESPONSE
      // ========================================================

      res.json({
        success:
          true,

        order,

        tuanvinh,

        message:
          'Đã lưu tracking. Bấm update Tuấn Vĩnh khi muốn lấy trạng thái mới.',
      });

    } catch (error) {
      console.error(
        '[SAVE TRACKING ERROR]',
        error
      );

      res.status(
        500
      ).json({
        success:
          false,

        message:
          error.message,
      });
    }
  }
);

// ============================================================
// FORCE REFRESH ORDER
// ============================================================

app.post(
  '/api/tuanvinh/refresh-order',
  async (
    req,
    res
  ) => {
    try {
      const orderId =
        cleanText(
          req.body?.order_id
        );

      if (!orderId) {
        return res.status(
          400
        ).json({
          success:
            false,

          message:
            'Order ID rỗng.',
        });
      }

      const payload =
        await readTaobaoOrders();

      const index =
        payload.orders.findIndex(
          (order) =>
            cleanText(
              order?.order_id
            ) ===
            orderId
        );

      if (
        index ===
        -1
      ) {
        return res.status(
          404
        ).json({
          success:
            false,

          message:
            'Không tìm thấy Order ID.',
        });
      }

      const order =
        payload.orders[
          index
        ];

      const tracking =
        cleanTracking(
          order?.tracking_number
        );

      if (!tracking) {
        return res.status(
          400
        ).json({
          success:
            false,

          message:
            'Order chưa có tracking.',
        });
      }

      // Xóa cache
      await deleteCache(
        tracking
      );

      // Force lookup
      const result =
        await trackTuanVinh(
          tracking,
          {
            forceRefresh:
              true,
          }
        );

      if (
        result?.success
      ) {
        const hasExitedVietnam = hasVietnamExit(result);

        order.tuanvinh =
          result;

        order.tuanvinh_locked =
          order.tuanvinh_locked === true ||
          hasExitedVietnam;

        if (hasExitedVietnam || result.current_status) {
          order.status = hasExitedVietnam
            ? VIETNAM_EXIT_STATUS
            : result.current_status;
        }

        payload.orders[
          index
        ] =
          order;

        await saveTaobaoOrders(
          payload
        );
      }

      res.json({
        success:
          true,

        order,

        tuanvinh:
          result,
      });

    } catch (error) {
      console.error(
        '[REFRESH ORDER ERROR]',
        error
      );

      res.status(
        500
      ).json({
        success:
          false,

        message:
          error.message,
      });
    }
  }
);

// ============================================================
// FILE SCAN
// ============================================================

app.post(
  '/api/files/scan',
  async (
    req,
    res
  ) => {
    try {
      const directory =
        req.body?.directory;

      if (!directory) {
        return res.status(
          400
        ).json({
          success:
            false,

          message:
            'Directory is required.',
        });
      }

      const files =
        await scanDirectory(
          directory
        );

      res.json({
        success:
          true,

        directory,

        count:
          files.length,

        files,
      });

    } catch (error) {
      console.error(
        '[FILE SCAN ERROR]',
        error
      );

      res.status(
        500
      ).json({
        success:
          false,

        message:
          error.message,
      });
    }
  }
);
// ============================================================
// SKU MASTER
// ============================================================

const SKU_MASTER_FILE = path.join(
  DATA_DIR,
  'sku_master.json'
);

const SKU_LINKS_FILE = path.join(
  DATA_DIR,
  'sku_links.json'
);

const SHOP_SALES_FILE = path.join(
  DATA_DIR,
  'shop_sales.json'
);

const APP_SETTINGS_FILE = path.join(
  DATA_DIR,
  'app_settings.json'
);

// ---------- Read JSON safely ----------
async function readJsonFile(file, fallback) {
  try {
    const raw = await fs.readFile(
      file,
      'utf-8'
    );

    const data = JSON.parse(raw);

    return data;
  } catch {
    return fallback;
  }
}

// ---------- Write JSON safely ----------
async function writeJsonFile(file, data) {
  await fs.writeFile(
    file,
    JSON.stringify(
      data,
      null,
      2
    ),
    'utf-8'
  );
}

// ============================================================
// SKU MASTER API
// ============================================================

// GET all SKU Master
app.get(
  '/api/sku/master',
  async (
    req,
    res
  ) => {
    try {
      const data =
        await readJsonFile(
          SKU_MASTER_FILE,
          []
        );

      res.json({
        success: true,
        skus: Array.isArray(data)
          ? data
          : [],
      });

    } catch (error) {
      console.error(
        '[SKU MASTER GET ERROR]',
        error
      );

      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// SAVE entire SKU Master
app.post(
  '/api/sku/master',
  async (
    req,
    res
  ) => {
    try {
      const skus =
        Array.isArray(req.body?.skus)
          ? req.body.skus
          : [];

      await writeJsonFile(
        SKU_MASTER_FILE,
        skus
      );

      res.json({
        success: true,
        skus,
      });

    } catch (error) {
      console.error(
        '[SKU MASTER SAVE ERROR]',
        error
      );

      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// DELETE SKU Master
app.delete(
  '/api/sku/master/:id',
  async (
    req,
    res
  ) => {
    try {
      const id =
        String(
          req.params.id || ''
        ).trim();

      const current =
        await readJsonFile(
          SKU_MASTER_FILE,
          []
        );

      const next =
        Array.isArray(current)
          ? current.filter(
              (sku) =>
                String(sku?.id || '') !== id
            )
          : [];

      await writeJsonFile(
        SKU_MASTER_FILE,
        next
      );

      res.json({
        success: true,
        skus: next,
      });

    } catch (error) {
      console.error(
        '[SKU MASTER DELETE ERROR]',
        error
      );

      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// ============================================================
// SKU LINKS API
// ============================================================

// GET Purchase → SKU links
app.get(
  '/api/sku/links',
  async (
    req,
    res
  ) => {
    try {
      const data =
        await readJsonFile(
          SKU_LINKS_FILE,
          {}
        );

      res.json({
        success: true,
        links:
          data &&
          typeof data === 'object' &&
          !Array.isArray(data)
            ? data
            : {},
      });

    } catch (error) {
      console.error(
        '[SKU LINKS GET ERROR]',
        error
      );

      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// SAVE Purchase → SKU links
app.post(
  '/api/sku/links',
  async (
    req,
    res
  ) => {
    try {
      const links =
        req.body?.links &&
        typeof req.body.links === 'object' &&
        !Array.isArray(req.body.links)
          ? req.body.links
          : {};

      await writeJsonFile(
        SKU_LINKS_FILE,
        links
      );

      res.json({
        success: true,
        links,
      });

    } catch (error) {
      console.error(
        '[SKU LINKS SAVE ERROR]',
        error
      );

      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// ============================================================
// SAMU.SHOP SALES API
// ============================================================

app.get(
  '/api/shop/sales',
  async (
    req,
    res
  ) => {
    try {
      const data = await readJsonFile(
        SHOP_SALES_FILE,
        []
      );

      res.json({
        success: true,
        sales: Array.isArray(data) ? data : [],
      });
    } catch (error) {
      console.error(
        '[SHOP SALES GET ERROR]',
        error
      );

      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

app.post(
  '/api/shop/sales',
  async (
    req,
    res
  ) => {
    try {
      const sales = Array.isArray(req.body?.sales)
        ? req.body.sales
        : [];

      await writeJsonFile(
        SHOP_SALES_FILE,
        sales
      );

      res.json({
        success: true,
        sales,
      });
    } catch (error) {
      console.error(
        '[SHOP SALES SAVE ERROR]',
        error
      );

      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// ============================================================
// APP SETTINGS API
// ============================================================

app.get(
  '/api/settings',
  async (
    req,
    res
  ) => {
    try {
      const data = await readJsonFile(
        APP_SETTINGS_FILE,
        {}
      );

      res.json({
        success: true,
        settings: data && typeof data === 'object' && !Array.isArray(data)
          ? data
          : {},
      });
    } catch (error) {
      console.error(
        '[APP SETTINGS GET ERROR]',
        error
      );

      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

app.post(
  '/api/settings',
  async (
    req,
    res
  ) => {
    try {
      const current = await readJsonFile(
        APP_SETTINGS_FILE,
        {}
      );
      const incoming = req.body?.settings;
      const settings = incoming && typeof incoming === 'object' && !Array.isArray(incoming)
        ? incoming
        : {};
      const next = {
        ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
        ...settings,
      };

      await writeJsonFile(
        APP_SETTINGS_FILE,
        next
      );

      res.json({
        success: true,
        settings: next,
      });
    } catch (error) {
      console.error(
        '[APP SETTINGS SAVE ERROR]',
        error
      );

      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  '/api/health',
  async (
    req,
    res
  ) => {
    const loggedIn =
      await hasTuanVinhSession();

    res.json({
      success:
        true,

      service:
        'SAMUCHAN',

      port:
        PORT,

      tuanvinhLoggedIn:
        loggedIn,

      dataFile:
        TAOBAO_ORDERS_FILE,

      time:
        new Date().toISOString(),
    });
  }
);

// ============================================================
// PRODUCTION WEB APP
// ============================================================

// Railway chạy một service duy nhất. Khi deploy, Express phục vụ luôn bản
// React đã build để giao diện và API cùng chung một public URL.
const FRONTEND_DIST = path.join(__dirname, 'dist');
app.use(express.static(FRONTEND_DIST));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
});

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log('');
    console.log(
      '================================================'
    );
    console.log(
      '             SAMUCHAN BACKEND'
    );
    console.log(
      '================================================'
    );
    console.log(
      `API: http://localhost:${PORT}`
    );
    console.log(
      `Data: ${DATA_DIR}`
    );
    console.log(
      `Taobao orders: ${TAOBAO_ORDERS_FILE}`
    );
    console.log(
      `Tuấn Vĩnh session: ${TUANVINH_SESSION_FILE}`
    );
    console.log(
      `Tuấn Vĩnh cache: ${TUANVINH_CACHE_FILE}`
    );
    console.log(
      '================================================'
    );
    console.log('');
  }
);
