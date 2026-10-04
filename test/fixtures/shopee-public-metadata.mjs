export const PUBLIC_SHOP_ID = '452200291';
export const PUBLIC_ITEM_ID = '17701438002';
export const PUBLIC_IMAGE = 'https://down-vn.img.susercontent.com/file/vn-11134207-81ztc-mmwr64zo6oznda';
export const PUBLIC_TITLE = 'Kính cường lực nhũ kim tuyến bảo vệ Camera 15 Pro Max';

export function publicProductNode(overrides = {}, shopId = PUBLIC_SHOP_ID, itemId = PUBLIC_ITEM_ID) {
  return {
    '@type': 'Product', name: PUBLIC_TITLE,
    url: `https://bangiare.com/kinh-camera-zk1.${itemId}.${shopId}.html`,
    sku: `1__${itemId}__${shopId}`, image: [PUBLIC_IMAGE],
    offers: { seller: { url: `https://shopee.vn/shop/${shopId}`,
      identifier: { propertyID: 'Shopee shop ID', value: shopId } } },
    ...overrides
  };
}

export function publicProductHtml(node = publicProductNode(), canonical = publicProductNode().url) {
  return `<html><head><link rel="canonical" href="${canonical}"><script type="application/ld+json">${JSON.stringify(node)}</script></head></html>`;
}
