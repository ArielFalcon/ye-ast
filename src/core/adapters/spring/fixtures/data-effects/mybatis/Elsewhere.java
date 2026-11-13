package shop.elsewhere;
public interface Elsewhere {
 @org.apache.ibatis.annotations.Select("select * from audits") String list();
}
