import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/tags' },
  {
    path: '/tags',
    name: 'tags',
    component: () => import('@/views/TagMatrixView.vue'),
    meta: { title: 'Tag management' },
  },
  {
    path: '/paths',
    name: 'paths',
    component: () => import('@/views/PathMatrixView.vue'),
    meta: { title: 'Folder management' },
  },
  // The two views this replaced - keep the links working.
  { path: '/root-folders', redirect: '/paths' },
  { path: '/storage', redirect: '/paths' },
  {
    path: '/import-lists',
    name: 'import-lists',
    component: () => import('@/views/ImportListFleetView.vue'),
    meta: { title: 'Import lists' },
  },
  {
    path: '/media',
    name: 'media',
    component: () => import('@/views/MediaFleetView.vue'),
    meta: { title: 'Media management', hint: 'titles across every instance' },
  },
  {
    path: '/queue',
    name: 'queue',
    component: () => import('@/views/QueueView.vue'),
    meta: { title: 'Pending fleet changes', hint: 'review, reorder and apply' },
  },
  {
    path: '/instances',
    name: 'instances',
    component: () => import('@/views/InstancesView.vue'),
    meta: { title: 'Instances', hint: 'connections and health' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/tags' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    hint?: string;
  }
}
