package shop.scanned;
public interface Scanned {
 @org.apache.ibatis.annotations.Select("select * from audits") String list();
}
