package shop.mapper;
import org.apache.ibatis.annotations.Mapper;
@Mapper
public interface UserMapper {
 void insert(User user);
 User findById(String id);
 void touch(String id);
 void ghost(String id);
 void twice(String id);
 void renamed(String id);
 default int helper() { return 1; }
}
