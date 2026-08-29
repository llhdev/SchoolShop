import { supabase } from '../lib/supabase';
import { Category } from '../types';
import { CACHE_KEYS, getCached, setCached } from './cache';

interface DbCategory {
  name: string;
}

function toCategory(db: DbCategory): Category {
  return db.name;
}

export async function loadCategoriesFromCache(): Promise<Category[]> {
  return (await getCached<Category[]>(CACHE_KEYS.categories)) ?? [];
}

export async function saveCategoriesToCache(categories: Category[]): Promise<void> {
  await setCached(CACHE_KEYS.categories, categories);
}

export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase.from('categories').select('name').order('name');
  if (error) throw error;
  return (data ?? []).map(toCategory);
}

export async function createCategory(category: Category): Promise<Category> {
  const { error } = await supabase.from('categories').insert({ name: category });
  if (error) throw error;
  return category;
}

export async function deleteCategory(category: Category): Promise<void> {
  const { error } = await supabase.from('categories').delete().eq('name', category);
  if (error) throw error;
}

export async function seedCategories(categories: Category[]): Promise<void> {
  if (categories.length === 0) return;
  const { error } = await supabase
    .from('categories')
    .upsert(categories.map((name) => ({ name })));
  if (error) throw error;
}

export function subscribeToCategories(onChange: (categories: Category[]) => void) {
  const subscription = supabase
    .channel('categories_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'categories' },
      async () => {
        try {
          const categories = await fetchCategories();
          onChange(categories);
        } catch {
          // Keep cached data if the refresh fails.
        }
      }
    )
    .subscribe();
  return () => {
    supabase.removeChannel(subscription);
  };
}
