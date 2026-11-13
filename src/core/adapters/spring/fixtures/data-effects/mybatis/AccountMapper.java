package shop.mapper;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;
@Mapper
public interface AccountMapper {
 @Select("select * from accounts where id = #{id}") Account find(String id);
 @Insert({"insert into accounts", "(id) values (#{id})"}) void add(Account account);
 @Update("update accounts set name = #{name}") void rename(String name);
 @Delete("delete from accounts") void clear();
 @Select("select a.id from accounts a join owners o on o.id = a.owner") String owners();
 @Select("select * from ${table}") String dynamic(String table);
 @Select("select 1") @Delete("delete from accounts") void both();
 @Select("select 1 from accounts for update") String locked();
}
