import { ChevronLeft, ChevronRight } from 'lucide-react';
import './Pagination.css';
export default function Pagination({page,total,onChange}) {
  const totalPages=Math.max(1,Math.ceil(total/7));
  const currentPage=Math.min(page,totalPages);
  const pages=Array.from({length:totalPages},(_,i)=>i+1).filter(p=>Math.abs(p-currentPage)<=2 || p===1 || p===totalPages);
  return <nav className="module-pagination" aria-label="Pagination">
    <span>Page {currentPage} of {totalPages}</span>
    <button type="button" className="page-btn" aria-label="Previous page" disabled={currentPage===1} onClick={()=>onChange(currentPage-1)}><ChevronLeft size={16}/></button>
    {pages.map(p=><button key={p} type="button" className={`page-btn ${p===currentPage?'active':''}`} aria-current={p===currentPage?'page':undefined} onClick={()=>onChange(p)}>{p}</button>)}
    <button type="button" className="page-btn" aria-label="Next page" disabled={currentPage===totalPages} onClick={()=>onChange(currentPage+1)}><ChevronRight size={16}/></button>
  </nav>;
}
